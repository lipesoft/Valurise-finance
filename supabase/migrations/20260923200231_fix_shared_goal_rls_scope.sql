-- Correlate each shared-goal membership check with the row protected by the
-- policy. The previous unqualified shared_goal_id resolved to the inner table,
-- turning the comparison into a tautology and widening access across goals.

drop policy if exists "active members read member list"
  on public.shared_goal_members;
create policy "active members read member list"
  on public.shared_goal_members
  for select to authenticated
  using (
    (select public.current_user_is_active())
    and exists (
      select 1
      from public.shared_goal_members as membership
      where membership.shared_goal_id = shared_goal_members.shared_goal_id
        and membership.user_id = (select auth.uid())
    )
  );

drop policy if exists "active members read contributions"
  on public.shared_goal_contributions;
create policy "active members read contributions"
  on public.shared_goal_contributions
  for select to authenticated
  using (
    (select public.current_user_is_active())
    and exists (
      select 1
      from public.shared_goal_members as membership
      where membership.shared_goal_id = shared_goal_contributions.shared_goal_id
        and membership.user_id = (select auth.uid())
    )
  );

drop policy if exists "active members add own contribution"
  on public.shared_goal_contributions;
create policy "active members add own contribution"
  on public.shared_goal_contributions
  for insert to authenticated
  with check (
    (select public.current_user_is_active())
    and user_id = (select auth.uid())
    and exists (
      select 1
      from public.shared_goal_members as membership
      where membership.shared_goal_id = shared_goal_contributions.shared_goal_id
        and membership.user_id = (select auth.uid())
    )
  );
