-- Exposes limited participant labels and invitation state to authorized users.
-- participants. The caller must already own, belong to, or be invited to each
-- requested goal; profile rows and financial data remain protected by RLS.
create or replace function public.list_shared_goal_participants(p_goal_ids uuid[])
returns table (
  shared_goal_id uuid,
  participant_name text,
  participant_role text,
  invitation_status text
)
language plpgsql
stable
security definer
set search_path = pg_catalog
as $function$
declare
  actor_id uuid := auth.uid();
begin
  if actor_id is null or not public.current_user_is_active() then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  if p_goal_ids is null or cardinality(p_goal_ids) = 0 then
    return;
  end if;

  if cardinality(p_goal_ids) > 250 then
    raise exception 'too many shared goals requested' using errcode = '22023';
  end if;

  return query
  with requested_goals as (
    select distinct requested.goal_id
    from unnest(p_goal_ids) as requested(goal_id)
    where requested.goal_id is not null
  ), accessible_goals as (
    select goal.id, goal.owner_id
    from public.shared_goals as goal
    join requested_goals as requested on requested.goal_id = goal.id
    where goal.owner_id = actor_id
      or exists (
        select 1
        from public.shared_goal_members as membership
        where membership.shared_goal_id = goal.id
          and membership.user_id = actor_id
      )
      or exists (
        select 1
        from public.shared_goal_invites as invitation
        where invitation.shared_goal_id = goal.id
          and invitation.recipient_id = actor_id
          and invitation.status in ('pending', 'accepted')
      )
  ), participants as (
    select
      membership.shared_goal_id,
      membership.user_id,
      membership.role as participant_role,
      case when membership.role = 'owner' then 'owner' else 'accepted' end as invitation_status
    from accessible_goals as goal
    join public.shared_goal_members as membership on membership.shared_goal_id = goal.id
    where membership.role = 'owner'
      or goal.owner_id = actor_id
      or exists (
        select 1
        from public.shared_goal_members as current_membership
        where current_membership.shared_goal_id = goal.id
          and current_membership.user_id = actor_id
      )

    union all

    select
      invitation.shared_goal_id,
      invitation.recipient_id,
      'member'::text as participant_role,
      'pending'::text as invitation_status
    from accessible_goals as goal
    join public.shared_goal_invites as invitation on invitation.shared_goal_id = goal.id
    where goal.owner_id = actor_id
      and invitation.status = 'pending'
  )
  select
    participant.shared_goal_id,
    coalesce(
      left(nullif(regexp_replace(trim(profile.full_name), '[[:space:]]+', ' ', 'g'), ''), 120),
      'Usuário Valurise'
    ) as participant_name,
    participant.participant_role::text,
    participant.invitation_status::text
  from participants as participant
  join public.profiles as profile on profile.id = participant.user_id
  order by participant.shared_goal_id,
    case participant.participant_role when 'owner' then 0 else 1 end,
    participant.invitation_status,
    lower(coalesce(left(nullif(regexp_replace(trim(profile.full_name), '[[:space:]]+', ' ', 'g'), ''), 120), 'usuário valurise'));
end;
$function$;

revoke all on function public.list_shared_goal_participants(uuid[]) from public, anon, authenticated;
grant execute on function public.list_shared_goal_participants(uuid[]) to authenticated;
