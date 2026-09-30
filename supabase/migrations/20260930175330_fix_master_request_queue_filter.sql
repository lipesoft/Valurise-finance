-- The Master requests screen requests a combined view of verified and
-- unverified applications. Keep unverified applications visible only in the
-- Master queue's waiting-for-email section; approval is still restricted to
-- verified pending_review requests by master_transition_account.
create or replace function public.master_list_accounts(
  p_search text default null,
  p_status text default 'all',
  p_page integer default 1,
  p_page_size integer default 25
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, auth
set row_security = off
as $$
declare
  safe_page integer := greatest(coalesce(p_page, 1), 1);
  safe_page_size integer := least(greatest(coalesce(p_page_size, 25), 1), 100);
  safe_search text := left(trim(coalesce(p_search, '')), 100);
  safe_status text := coalesce(nullif(p_status, ''), 'all');
  result jsonb;
begin
  if safe_status not in ('all', 'requests', 'pending', 'pending_email', 'verification_required', 'active', 'disabled', 'trashed', 'rejected') then
    raise exception 'invalid account filter' using errcode = '22023';
  end if;

  with account_rows as (
    select
      auth_user.id,
      auth_user.email,
      auth_user.email_confirmed_at,
      auth_user.last_sign_in_at,
      auth_user.created_at,
      profile.full_name,
      profile.username,
      profile.account_role::text as role,
      profile.account_status::text as stored_status,
      request.request_status,
      coalesce(request.requested_at, profile.created_at, auth_user.created_at) as requested_at,
      request.invite_id,
      invitation.expires_at as invite_expires_at,
      invitation.used_at as invite_used_at,
      case
        when invitation.id is null then 'none'
        when invitation.revoked_at is not null then 'revoked'
        when invitation.used_by is not null and invitation.used_by <> auth_user.id then 'used'
        when invitation.expires_at <= now() then 'expired'
        when invitation.used_by = auth_user.id then 'claimed'
        else 'valid'
      end as invite_state,
      case
        when request.request_status = 'rejected' then 'rejected'
        when profile.account_status = 'pending' and request.request_status = 'pending_review' then 'pending'
        when profile.account_status = 'pending' and request.request_status = 'pending_email' then 'pending_email'
        when profile.account_status = 'pending' and request.request_status = 'verification_required' then 'verification_required'
        when profile.account_status = 'pending' and request.user_id is null then 'verification_required'
        else profile.account_status::text
      end as status
    from public.profiles profile
    join auth.users auth_user on auth_user.id = profile.id
    left join public.access_request_details request on request.user_id = profile.id
    left join public.access_invites invitation on invitation.id = request.invite_id
  ), filtered as (
    select * from account_rows
    where (
        safe_status = 'all'
        or (safe_status = 'requests' and status in ('pending', 'pending_email', 'verification_required'))
        or status = safe_status
      )
      and (safe_search = ''
        or strpos(lower(coalesce(email, '')), lower(safe_search)) > 0
        or strpos(lower(coalesce(full_name, '')), lower(safe_search)) > 0
        or strpos(lower(coalesce(username, '')), lower(safe_search)) > 0)
  ), page_rows as (
    select * from filtered
    order by created_at desc, id
    limit safe_page_size offset (safe_page - 1) * safe_page_size
  ), stats as (
    select
      count(*) filter (where role <> 'master') as total,
      count(*) filter (where status = 'pending') as pending,
      count(*) filter (where status in ('pending_email', 'verification_required')) as email_pending,
      count(*) filter (where status = 'active' and role <> 'master') as active,
      count(*) filter (where status = 'disabled') as disabled,
      count(*) filter (where status = 'trashed') as trashed,
      count(*) filter (where status = 'rejected') as rejected
    from account_rows
  )
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(to_jsonb(page_rows) order by created_at desc, id) from page_rows), '[]'::jsonb),
    'total', (select count(*) from filtered),
    'page', safe_page,
    'pageSize', safe_page_size,
    'stats', (select to_jsonb(stats) from stats)
  ) into result;

  return result;
end;
$$;

-- CREATE OR REPLACE preserves existing grants; explicitly keep the RPC
-- restricted to the server-side service role for defense in depth.
revoke all on function public.master_list_accounts(text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.master_list_accounts(text, text, integer, integer) to service_role;
