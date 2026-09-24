begin;

-- Pending invite recipients may preview only the goal summary needed to
-- identify the invitation. Membership, contributions and account data remain
-- inaccessible until the invite is accepted.
drop policy if exists "pending invite recipients can preview shared goals"
  on public.shared_goals;
create policy "pending invite recipients can preview shared goals"
  on public.shared_goals
  for select to authenticated
  using (
    (select public.current_user_is_active())
    and exists (
      select 1
      from public.shared_goal_invites as invitation
      where invitation.shared_goal_id = shared_goals.id
        and invitation.recipient_id = (select auth.uid())
        and invitation.status = 'pending'
    )
  );

-- Realtime does not emit table changes unless the table is in this publication.
do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'shared_goal_invites'
  ) then
    alter publication supabase_realtime add table public.shared_goal_invites;
  end if;
end;
$$;

commit;
