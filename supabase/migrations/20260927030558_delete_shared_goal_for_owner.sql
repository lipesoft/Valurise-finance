-- Delete a shared goal only for its creator, and unlink the creator's local
-- mirror in the same versioned financial-state transaction. Foreign-key
-- cascades remove invitations, memberships and the shared contribution ledger;
-- transaction history stored in the owner's financial state is preserved.
begin;

create or replace function public.delete_shared_goal(
  p_shared_goal_id uuid,
  p_local_goal_id uuid,
  p_expected_version integer
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  actor_id uuid := (select auth.uid());
  personal_workspace_id uuid;
  current_state jsonb;
  current_version integer;
  next_version integer;
  updated_goals jsonb;
  locked_goal_id uuid;
begin
  if actor_id is null
     or not public.current_user_is_active()
     or not valurise_private.has_personal_workspace_membership() then
    raise exception 'active personal account required' using errcode = '42501';
  end if;

  if p_shared_goal_id is null or p_local_goal_id is null
     or p_expected_version is null or p_expected_version <= 0 then
    raise exception 'valid goal and financial state version are required' using errcode = '22023';
  end if;

  -- Lock financial state first, matching contribute_to_shared_goal and
  -- avoiding a goal/state lock-order inversion during concurrent contributions.
  select financial_state.state, financial_state.version, financial_state.workspace_id
  into current_state, current_version, personal_workspace_id
  from public.user_financial_state as financial_state
  join public.workspaces as workspace
    on workspace.id = financial_state.workspace_id
   and workspace.type = 'personal'
   and workspace.archived_at is null
  join public.workspace_memberships as membership
    on membership.workspace_id = workspace.id
   and membership.user_id = actor_id
   and membership.status = 'active'
  where financial_state.user_id = actor_id
  for update of financial_state;

  if not found then
    raise exception 'synchronized personal financial state is required' using errcode = 'P0002';
  end if;

  if current_version is distinct from p_expected_version then
    raise exception 'financial state changed in another session; refresh before deleting'
      using errcode = '40001';
  end if;

  if not exists (
    select 1
    from jsonb_array_elements(
      case when jsonb_typeof(current_state #> '{data,goals}') = 'array'
        then current_state #> '{data,goals}' else '[]'::jsonb end
    ) as personal_goal(value)
    where personal_goal.value->>'id' = p_local_goal_id::text
      and personal_goal.value->>'sharedGoalId' = p_shared_goal_id::text
  ) then
    raise exception 'linked personal goal is not available' using errcode = '42501';
  end if;

  select goal.id into locked_goal_id
  from public.shared_goals as goal
  where goal.id = p_shared_goal_id
    and goal.owner_id = actor_id
  for update;

  if not found then
    raise exception 'only the goal creator can delete this shared goal' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(personal_goal.value order by personal_goal.ordinality), '[]'::jsonb)
  into updated_goals
  from jsonb_array_elements(current_state #> '{data,goals}')
       with ordinality as personal_goal(value, ordinality)
  where not (
    personal_goal.value->>'id' = p_local_goal_id::text
    and personal_goal.value->>'sharedGoalId' = p_shared_goal_id::text
  );

  if current_version = 2147483647 then
    raise exception 'financial state version limit reached' using errcode = '22003';
  end if;

  next_version := current_version + 1;
  update public.user_financial_state
  set state = jsonb_set(current_state, '{data,goals}', updated_goals, true),
      version = next_version
  where workspace_id = personal_workspace_id;

  -- The schema cascades this deletion to invitations, memberships and shared
  -- contributions. The owner check above is repeated for defense in depth.
  delete from public.shared_goals as goal
  where goal.id = p_shared_goal_id
    and goal.owner_id = actor_id;

  if not found then
    raise exception 'only the goal creator can delete this shared goal' using errcode = '42501';
  end if;

  return jsonb_build_object('version', next_version);
end;
$function$;

revoke all on function public.delete_shared_goal(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.delete_shared_goal(uuid, uuid, integer) to authenticated;

commit;
