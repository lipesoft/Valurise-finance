-- Trigger helpers are never API endpoints.
revoke all on function public.add_shared_goal_owner() from public, anon, authenticated;

-- Shared-goal commands require a signed-in, active user. The function bodies
-- validate ownership/recipient membership; anon must never call them.
revoke execute on function public.create_shared_goal(text, bigint, date) from public, anon;
revoke execute on function public.invite_to_shared_goal(uuid, text) from public, anon;
revoke execute on function public.respond_shared_goal_invite(uuid, boolean) from public, anon;
grant execute on function public.create_shared_goal(text, bigint, date) to authenticated;
grant execute on function public.invite_to_shared_goal(uuid, text) to authenticated;
grant execute on function public.respond_shared_goal_invite(uuid, boolean) to authenticated;

-- These functions are used in RLS predicates by authenticated users only.
revoke execute on function public.current_user_is_active() from public, anon;
revoke execute on function public.current_user_is_master() from public, anon;
grant execute on function public.current_user_is_active(), public.current_user_is_master() to authenticated;
