begin;

-- Allow the admin API to persist an explicit reconciliation state when an
-- external Auth change succeeds but its audit result cannot be confirmed.
create or replace function public.master_finish_admin_audit(
  p_actor_id uuid,
  p_audit_id uuid,
  p_outcome text,
  p_detail_code text default null
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
begin
  if not exists (
    select 1 from public.profiles
    where id = p_actor_id and account_role = 'master' and account_status = 'active'
  ) then raise exception 'master authorization required' using errcode = '42501'; end if;
  if p_outcome not in ('completed', 'failed', 'needs_attention') then
    raise exception 'invalid audit outcome' using errcode = '22023';
  end if;
  if p_detail_code is not null and p_detail_code not in (
    'auth_ban_failed',
    'auth_unban_failed',
    'auth_delete_failed',
    'audit_reconciliation_required'
  ) then
    raise exception 'invalid audit detail' using errcode = '22023';
  end if;
  update public.master_audit_log
  set outcome = p_outcome, detail_code = p_detail_code
  where id = p_audit_id and actor_id = p_actor_id and outcome = 'started';
  return found;
end;
$$;

revoke all on function public.master_finish_admin_audit(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.master_finish_admin_audit(uuid, uuid, text, text) to service_role;

commit;
