-- Create a shared goal and its owner membership in one protected operation.
-- The client never receives privileges to assign arbitrary members.
create or replace function public.create_shared_goal(
  p_name text,
  p_target_cents bigint,
  p_target_date date default null
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

  if p_target_cents is null or p_target_cents <= 0 then
    raise exception 'a positive target amount is required';
  end if;

  insert into public.shared_goals (owner_id, name, target_cents, target_date)
  values (auth.uid(), trim(p_name), p_target_cents, p_target_date)
  returning id into created_goal_id;

  insert into public.shared_goal_members (shared_goal_id, user_id, role)
  values (created_goal_id, auth.uid(), 'owner')
  on conflict (shared_goal_id, user_id) do nothing;

  return created_goal_id;
end;
$$;

revoke all on function public.create_shared_goal(text, bigint, date) from public;
grant execute on function public.create_shared_goal(text, bigint, date) to authenticated;
