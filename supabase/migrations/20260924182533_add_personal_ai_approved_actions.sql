begin;

-- Writing actions are opt-in and disabled for every existing connection.
alter table public.personal_ai_connections
  add column if not exists actions_enabled boolean not null default false;

-- Proposals contain only a normalized, allow-listed transaction draft. They do
-- not contain prompts, provider keys, or arbitrary JSON to be executed.
create table if not exists public.personal_ai_action_proposals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  action_type text not null check (action_type in ('income', 'expense')),
  amount_cents bigint not null check (amount_cents > 0 and amount_cents <= 100000000000),
  category text not null check (char_length(trim(category)) between 1 and 80),
  account_label text not null check (char_length(trim(account_label)) between 1 and 140),
  description text not null check (char_length(trim(description)) between 1 and 140),
  transaction_date date not null,
  expected_state_version integer not null check (expected_state_version > 0),
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'cancelled', 'expired', 'stale')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '10 minutes'),
  acted_at timestamptz,
  executed_transaction_id text
);

create index if not exists personal_ai_action_proposals_owner_pending_idx
  on public.personal_ai_action_proposals (user_id, created_at desc)
  where status = 'pending';

alter table public.personal_ai_action_proposals enable row level security;
revoke all on table public.personal_ai_action_proposals from public, anon, authenticated;
grant all on table public.personal_ai_action_proposals to service_role;

create or replace function public.confirm_personal_ai_transaction(p_proposal_id uuid, p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_user_id uuid := p_user_id;
  v_action public.personal_ai_action_proposals%rowtype;
  v_actions_enabled boolean;
  v_insights_enabled boolean;
  v_consent_version text;
  v_consent_at timestamptz;
  v_state jsonb;
  v_next_state jsonb;
  v_version integer;
  v_next_version integer;
  v_transaction jsonb;
  v_transaction_id text := gen_random_uuid()::text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'server authorization required' using errcode = '42501';
  end if;
  if v_user_id is null or not exists (
    select 1 from public.profiles as profile
    where profile.id = v_user_id
      and profile.account_status = 'active'
      and profile.account_role = 'user'
  ) then
    raise exception 'active user required' using errcode = '42501';
  end if;

  select proposal.* into v_action
  from public.personal_ai_action_proposals as proposal
  where proposal.id = p_proposal_id and proposal.user_id = v_user_id
  for update;
  if not found then
    raise exception 'proposal not found' using errcode = 'P0002';
  end if;
  if v_action.status <> 'pending' then
    return jsonb_build_object('ok', false, 'reason', 'not_pending');
  end if;
  if v_action.expires_at <= clock_timestamp() then
    update public.personal_ai_action_proposals
      set status = 'expired', acted_at = clock_timestamp()
      where id = v_action.id;
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;

  select connection.actions_enabled, connection.insights_enabled
    into v_actions_enabled, v_insights_enabled
  from public.personal_ai_connections as connection
  where connection.user_id = v_user_id;
  select consent.ai_data_sharing_version, consent.ai_data_sharing_accepted_at
    into v_consent_version, v_consent_at
  from public.user_consents as consent
  where consent.user_id = v_user_id;
  if coalesce(v_actions_enabled, false) is not true
    or coalesce(v_insights_enabled, false) is not true
    or v_consent_version is distinct from '2026-09-24-v2'
    or v_consent_at is null then
    update public.personal_ai_action_proposals
      set status = 'cancelled', acted_at = clock_timestamp()
      where id = v_action.id;
    return jsonb_build_object('ok', false, 'reason', 'permission_revoked');
  end if;

  select financial_state.state, financial_state.version
    into v_state, v_version
  from public.user_financial_state as financial_state
  where financial_state.user_id = v_user_id
  for update;
  if not found then
    update public.personal_ai_action_proposals
      set status = 'stale', acted_at = clock_timestamp()
      where id = v_action.id;
    return jsonb_build_object('ok', false, 'reason', 'state_missing');
  end if;
  if v_version <> v_action.expected_state_version then
    update public.personal_ai_action_proposals
      set status = 'stale', acted_at = clock_timestamp()
      where id = v_action.id;
    return jsonb_build_object('ok', false, 'reason', 'state_changed');
  end if;
  if v_action.action_type not in ('income', 'expense')
    or v_action.transaction_date > (clock_timestamp() at time zone 'America/Sao_Paulo')::date
    or not exists (
      select 1
      from pg_catalog.jsonb_array_elements_text(
        case when pg_catalog.jsonb_typeof(v_state #> '{data,categories}') = 'array'
          then v_state #> '{data,categories}' else '[]'::jsonb end
      ) as category(value)
      where category.value = v_action.category
    )
    or not exists (
      select 1
      from pg_catalog.jsonb_array_elements(
        case when pg_catalog.jsonb_typeof(v_state #> '{data,institutions}') = 'array'
          then v_state #> '{data,institutions}' else '[]'::jsonb end
      ) as institution(value)
      cross join lateral pg_catalog.jsonb_array_elements(
        case when pg_catalog.jsonb_typeof(institution.value->'accounts') = 'array'
          then institution.value->'accounts' else '[]'::jsonb end
      ) as account(value)
      where coalesce(institution.value->>'name', '') || ' • ' || coalesce(account.value->>'name', '') = v_action.account_label
        and not exists (
          select 1
          from pg_catalog.jsonb_array_elements(
            case when pg_catalog.jsonb_typeof(institution.value->'cards') = 'array'
              then institution.value->'cards' else '[]'::jsonb end
          ) as card(value)
          where coalesce(institution.value->>'name', '') || ' • ' || coalesce(card.value->>'name', '') = v_action.account_label
        )
    ) then
    update public.personal_ai_action_proposals
      set status = 'stale', acted_at = clock_timestamp()
      where id = v_action.id;
    return jsonb_build_object('ok', false, 'reason', 'details_changed');
  end if;

  v_transaction := pg_catalog.jsonb_build_object(
    'id', v_transaction_id,
    'type', v_action.action_type,
    'subtype', v_action.action_type,
    'amountCents', v_action.amount_cents,
    'category', v_action.category,
    'account', v_action.account_label,
    'description', v_action.description,
    'date', v_action.transaction_date::text || 'T12:00:00.000Z',
    'createdAt', pg_catalog.to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
  v_next_state := pg_catalog.jsonb_set(
    v_state,
    '{transactions}',
    (case when pg_catalog.jsonb_typeof(v_state->'transactions') = 'array'
      then v_state->'transactions' else '[]'::jsonb end) || pg_catalog.jsonb_build_array(v_transaction),
    true
  );
  v_next_version := v_version + 1;

  update public.user_financial_state
    set state = v_next_state, version = v_next_version
    where user_id = v_user_id;
  update public.personal_ai_action_proposals
    set status = 'approved', acted_at = clock_timestamp(), executed_transaction_id = v_transaction_id
    where id = v_action.id;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'version', v_next_version,
    'transaction', v_transaction
  );
end;
$$;

revoke all on function public.confirm_personal_ai_transaction(uuid, uuid) from public, anon, authenticated;
grant execute on function public.confirm_personal_ai_transaction(uuid, uuid) to service_role;

commit;
