begin;

-- Keep the pre-accept preview limited to the goal name, target and due date.
revoke select on table public.shared_goals from authenticated;
grant select (id, name, target_cents, target_date, created_at)
  on table public.shared_goals to authenticated;
revoke insert, update, delete on table public.shared_goals from authenticated;
revoke insert, update, delete on table public.shared_goal_contributions from authenticated;
drop policy if exists "active members remove own contribution" on public.shared_goal_contributions;
drop policy if exists "active users create shared goals" on public.shared_goals;
drop policy if exists "active owners update shared goals" on public.shared_goals;
drop policy if exists "active owners delete shared goals" on public.shared_goals;

-- Move historical opening balances into the member-only contribution ledger.
insert into public.shared_goal_contributions (
  shared_goal_id, user_id, amount_cents, note, contributed_at
)
select goal.id, goal.owner_id, goal.initial_cents, 'Saldo ao compartilhar', goal.created_at
from public.shared_goals as goal
where goal.initial_cents > 0
  and not exists (
    select 1 from public.shared_goal_contributions as contribution
    where contribution.shared_goal_id = goal.id
      and contribution.user_id = goal.owner_id
      and contribution.note = 'Saldo ao compartilhar'
  );

create or replace function public.create_shared_goal_with_initial_amount(
  p_name text,
  p_target_cents bigint,
  p_target_date date,
  p_initial_cents bigint
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  created_goal_id uuid;
begin
  if auth.uid() is null or not public.current_user_is_active() then
    raise exception 'active authentication required';
  end if;
  if char_length(trim(coalesce(p_name, ''))) not between 1 and 100 then
    raise exception 'a valid goal name is required';
  end if;
  if p_target_cents is null or p_target_cents <= 0 or p_target_cents > 9007199254740991 then
    raise exception 'a positive target amount is required';
  end if;
  if p_initial_cents is null or p_initial_cents < 0 or p_initial_cents > 9007199254740991 then
    raise exception 'initial amount must be between zero and the supported limit';
  end if;

  insert into public.shared_goals (owner_id, name, target_cents, target_date, initial_cents)
  values (auth.uid(), trim(p_name), p_target_cents, p_target_date, p_initial_cents)
  returning id into created_goal_id;

  -- The existing membership trigger and this narrow RPC write with definer
  -- privileges; the function above validates the caller and binds all rows to auth.uid().
  if p_initial_cents > 0 then
    insert into public.shared_goal_contributions (
      shared_goal_id, user_id, amount_cents, note, contributed_at
    ) values (
      created_goal_id, auth.uid(), p_initial_cents, 'Saldo ao compartilhar', clock_timestamp()
    );
  end if;

  return created_goal_id;
end;
$$;

create or replace function public.contribute_to_shared_goal(
  p_shared_goal_id uuid,
  p_amount_cents bigint,
  p_account_label text,
  p_transaction_date timestamptz,
  p_expected_version integer,
  p_local_goal_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  goal_name text;
  current_state jsonb;
  next_state jsonb;
  current_version integer;
  next_version integer;
  transaction_row jsonb;
  updated_goals jsonb;
begin
  if auth.uid() is null or not public.current_user_is_active() then
    raise exception 'active authentication required';
  end if;
  if p_amount_cents is null or p_amount_cents <= 0 or p_amount_cents > 9007199254740991 then
    raise exception 'a valid positive contribution is required';
  end if;
  if coalesce(trim(p_account_label), '') = '' or p_transaction_date is null or p_transaction_date > clock_timestamp() then
    raise exception 'account and a non-future transaction date are required';
  end if;

  select goal.name into goal_name
  from public.shared_goals as goal
  where goal.id = p_shared_goal_id
    and exists (
      select 1 from public.shared_goal_members as member
      where member.shared_goal_id = goal.id and member.user_id = auth.uid()
    );
  if goal_name is null then
    raise exception 'shared goal is not available to this account';
  end if;

  select financial_state.state, financial_state.version
  into current_state, current_version
  from public.user_financial_state as financial_state
  where financial_state.user_id = auth.uid()
  for update;
  if not found then
    raise exception 'synchronized financial state is required';
  end if;
  if current_version <> p_expected_version then
    raise exception 'financial state changed in another session; refresh before contributing'
      using errcode = '40001';
  end if;

  if not exists (
    select 1
    from jsonb_array_elements(
      case when jsonb_typeof(current_state #> '{data,institutions}') = 'array'
        then current_state #> '{data,institutions}' else '[]'::jsonb end
    ) as institution(value)
    cross join lateral jsonb_array_elements(coalesce(institution.value->'accounts', '[]'::jsonb)) as account(value)
    where coalesce(institution.value->>'name', '') || ' • ' || coalesce(account.value->>'name', '') = p_account_label
  ) then
    raise exception 'account is not available in this financial state';
  end if;

  if p_local_goal_id is not null and not exists (
    select 1
    from jsonb_array_elements(
      case when jsonb_typeof(current_state #> '{data,goals}') = 'array'
        then current_state #> '{data,goals}' else '[]'::jsonb end
    ) as personal_goal(value)
    where personal_goal.value->>'id' = p_local_goal_id::text
      and personal_goal.value->>'sharedGoalId' = p_shared_goal_id::text
  ) then
    raise exception 'linked personal goal is not available';
  end if;

  transaction_row := jsonb_build_object(
    'id', gen_random_uuid()::text,
    'type', 'transfer',
    'subtype', 'goal_contribution',
    'amountCents', p_amount_cents,
    'category', 'Meta • ' || goal_name,
    'account', p_account_label,
    'destinationAccount', 'Meta • ' || goal_name,
    'description', 'Contribuição • ' || goal_name,
    'date', to_char(p_transaction_date at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'createdAt', to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'sharedGoalId', p_shared_goal_id::text
  );
  if p_local_goal_id is not null then
    transaction_row := transaction_row || jsonb_build_object('goalId', p_local_goal_id::text);
    select coalesce(jsonb_agg(
      case
        when personal_goal.value->>'id' = p_local_goal_id::text then
          jsonb_set(
            personal_goal.value,
            '{currentCents}',
            to_jsonb(coalesce(nullif(personal_goal.value->>'currentCents', '')::bigint, 0) + p_amount_cents),
            true
          )
        else personal_goal.value
      end order by personal_goal.ordinality
    ), '[]'::jsonb)
    into updated_goals
    from jsonb_array_elements(
      case when jsonb_typeof(current_state #> '{data,goals}') = 'array'
        then current_state #> '{data,goals}' else '[]'::jsonb end
    ) with ordinality as personal_goal(value, ordinality);
    current_state := jsonb_set(current_state, '{data,goals}', updated_goals, true);
  end if;

  next_state := jsonb_set(
    current_state,
    '{transactions}',
    (case when jsonb_typeof(current_state->'transactions') = 'array'
      then current_state->'transactions' else '[]'::jsonb end) || jsonb_build_array(transaction_row),
    true
  );
  next_version := current_version + 1;

  update public.user_financial_state
  set state = next_state, version = next_version
  where user_id = auth.uid();

  insert into public.shared_goal_contributions (shared_goal_id, user_id, amount_cents, note, contributed_at)
  values (p_shared_goal_id, auth.uid(), p_amount_cents, 'Contribuição registrada no Valurise', p_transaction_date);

  return jsonb_build_object('version', next_version, 'transaction', transaction_row);
end;
$$;

revoke all on function public.create_shared_goal_with_initial_amount(text, bigint, date, bigint) from public, anon;
revoke all on function public.contribute_to_shared_goal(uuid, bigint, text, timestamptz, integer, uuid) from public, anon;
grant execute on function public.create_shared_goal_with_initial_amount(text, bigint, date, bigint) to authenticated;
grant execute on function public.contribute_to_shared_goal(uuid, bigint, text, timestamptz, integer, uuid) to authenticated;

commit;
