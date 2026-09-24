begin;

-- Keep accepted members and pending invitees on one SELECT policy while
-- limiting invitees to the shared-goal summary until they accept.
drop policy if exists "active members read shared goals"
  on public.shared_goals;
drop policy if exists "pending invite recipients can preview shared goals"
  on public.shared_goals;

create policy "active members and pending invitees read shared goals"
  on public.shared_goals
  for select to authenticated
  using (
    (select public.current_user_is_active())
    and (
      exists (
        select 1
        from public.shared_goal_members as membership
        where membership.shared_goal_id = shared_goals.id
          and membership.user_id = (select auth.uid())
      )
      or exists (
        select 1
        from public.shared_goal_invites as invitation
        where invitation.shared_goal_id = shared_goals.id
          and invitation.recipient_id = (select auth.uid())
          and invitation.status = 'pending'
      )
    )
  );

commit;
