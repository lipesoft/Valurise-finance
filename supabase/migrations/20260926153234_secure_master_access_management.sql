-- VALURISE: verified access requests, transactional Master decisions,
-- revocable access invitations, and durable administrative audit history.
-- Additive only: existing financial records and current account roles remain intact.

create table if not exists public.access_request_details (
  user_id uuid primary key references auth.users(id) on delete cascade,
  invite_id uuid references public.access_invites(id) on delete set null,
  request_status text not null default 'pending_email'
    check (request_status in ('pending_email', 'verification_required', 'pending_review', 'approved', 'rejected')),
  requested_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid references auth.users(id) on delete set null,
  check ((request_status in ('approved', 'rejected')) = (decided_at is not null))
);

alter table public.access_request_details enable row level security;
revoke all on public.access_request_details from public, anon, authenticated;
grant all on public.access_request_details to service_role;
create index if not exists access_request_details_status_requested_idx
  on public.access_request_details(request_status, requested_at desc);

-- Preserve requests that were created before this migration without treating
-- legacy auto-confirmed email addresses as proof of ownership.
-- Repair old Auth-only users whose profile creation trigger did not persist.
-- Do not copy a username here: an old value may collide with the unique index.
insert into public.profiles(id, full_name, username, account_status, account_role)
select auth_user.id,
  nullif(trim(coalesce(auth_user.raw_user_meta_data ->> 'full_name', '')), ''),
  null,
  'pending',
  'user'
from auth.users auth_user
where not exists (select 1 from public.profiles profile where profile.id = auth_user.id)
on conflict (id) do nothing;

insert into public.access_request_details(user_id, request_status, requested_at)
select profile.id,
  case when auth_user.email_confirmed_at is null then 'pending_email' else 'verification_required' end,
  coalesce(profile.created_at, auth_user.created_at)
from public.profiles profile
join auth.users auth_user on auth_user.id = profile.id
where profile.account_role = 'user' and profile.account_status = 'pending'
on conflict (user_id) do nothing;

-- Never infer ownership for legacy requests from email_confirmed_at alone:
-- the previous app version could administratively auto-confirm addresses.
-- A fresh password login or a new confirmation transition promotes them later.
drop trigger if exists valurise_prepare_access_request_details on public.access_request_details;
drop function if exists public.prepare_access_request_details();

grant select on public.access_request_details to authenticated;
drop policy if exists "active masters observe access requests" on public.access_request_details;
create policy "active masters observe access requests" on public.access_request_details
  for select to authenticated using ((select public.current_user_is_master()));

do $$ begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'access_request_details'
  ) then
    alter publication supabase_realtime add table public.access_request_details;
  end if;
end $$;

alter table public.access_invites
  add column if not exists revoked_at timestamptz,
  add column if not exists revoked_by uuid references auth.users(id) on delete set null;
create index if not exists access_invites_active_created_idx
  on public.access_invites(created_by, created_at desc)
  where revoked_at is null;

alter table public.master_audit_log
  add column if not exists target_ref uuid,
  add column if not exists invite_id uuid references public.access_invites(id) on delete set null,
  add column if not exists reason_code text,
  add column if not exists reason_note text,
  add column if not exists outcome text not null default 'completed',
  add column if not exists detail_code text;

update public.master_audit_log
set target_ref = target_user_id
where target_ref is null and target_user_id is not null;

alter table public.master_audit_log drop constraint if exists master_audit_log_action_check;
alter table public.master_audit_log add constraint master_audit_log_action_check
  check (action in (
    'approved', 'rejected', 'disabled', 'restored', 'trashed',
    'permanently_deleted', 'invite_created', 'invite_revoked'
  ));
alter table public.master_audit_log drop constraint if exists master_audit_log_outcome_check;
alter table public.master_audit_log add constraint master_audit_log_outcome_check
  check (outcome in ('started', 'completed', 'failed', 'needs_attention'));
alter table public.master_audit_log drop constraint if exists master_audit_log_reason_code_check;
alter table public.master_audit_log add constraint master_audit_log_reason_code_check
  check (reason_code is null or reason_code in (
    'duplicate_request', 'incomplete_request', 'policy_violation',
    'security_concern', 'user_requested', 'other'
  ));
alter table public.master_audit_log drop constraint if exists master_audit_log_reason_note_check;
alter table public.master_audit_log add constraint master_audit_log_reason_note_check
  check (reason_note is null or char_length(trim(reason_note)) between 1 and 280);
alter table public.master_audit_log drop constraint if exists master_audit_log_detail_code_check;
alter table public.master_audit_log add constraint master_audit_log_detail_code_check
  check (detail_code is null or detail_code in (
    'auth_ban_failed', 'auth_unban_failed', 'auth_delete_failed'
  ));
create index if not exists master_audit_log_created_idx
  on public.master_audit_log(created_at desc);
create index if not exists master_audit_log_target_ref_created_idx
  on public.master_audit_log(target_ref, created_at desc);

create or replace function public.sync_access_request_email_confirmation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if old.email_confirmed_at is null and new.email_confirmed_at is not null then
    update public.access_request_details
    set request_status = 'pending_review'
    where user_id = new.id and request_status in ('pending_email', 'verification_required');
  end if;
  return new;
end;
$$;
revoke all on function public.sync_access_request_email_confirmation() from public, anon, authenticated;
drop trigger if exists valurise_access_request_email_confirmed on auth.users;
create trigger valurise_access_request_email_confirmed
  after update of email_confirmed_at on auth.users
  for each row execute function public.sync_access_request_email_confirmation();

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
  if safe_status not in ('all', 'pending', 'pending_email', 'verification_required', 'active', 'disabled', 'trashed', 'rejected') then
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
    where (safe_status = 'all' or status = safe_status)
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

create or replace function public.master_transition_account(
  p_actor_id uuid,
  p_target_user_id uuid,
  p_action text,
  p_reason_code text default null,
  p_reason_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, auth
set row_security = off
as $$
declare
  target_role text;
  target_status text;
  target_confirmed_at timestamptz;
  request_status text;
  invite_target uuid;
  invite_used_by uuid;
  invite_expires timestamptz;
  invite_revoked timestamptz;
  audit_action text;
  desired_auth_action text;
  audit_id uuid;
  existing_outcome text;
  existing_action text;
  note text := nullif(trim(coalesce(p_reason_note, '')), '');
begin
  if not exists (
    select 1 from public.profiles
    where id = p_actor_id and account_role = 'master' and account_status = 'active'
  ) then raise exception 'master authorization required' using errcode = '42501'; end if;
  if p_target_user_id is null or p_action not in ('approve', 'reject', 'disable', 'restore', 'trash', 'delete_permanently') then
    raise exception 'invalid account action' using errcode = '22023';
  end if;
  if p_reason_code is not null and p_reason_code not in (
    'duplicate_request', 'incomplete_request', 'policy_violation',
    'security_concern', 'user_requested', 'other'
  ) then raise exception 'invalid reason code' using errcode = '22023'; end if;
  if note is not null and char_length(note) > 280 then
    raise exception 'reason note is too long' using errcode = '22023';
  end if;
  if p_action in ('reject', 'disable', 'trash', 'delete_permanently') and p_reason_code is null then
    raise exception 'reason code required' using errcode = '22023';
  end if;
  if p_target_user_id = p_actor_id then raise exception 'cannot manage own master account' using errcode = '42501'; end if;

  audit_action := case p_action
    when 'approve' then 'approved'
    when 'reject' then 'rejected'
    when 'disable' then 'disabled'
    when 'restore' then 'restored'
    when 'trash' then 'trashed'
    else 'permanently_deleted'
  end;
  desired_auth_action := case when p_action in ('approve', 'restore') then 'unban'
    when p_action = 'delete_permanently' then 'delete' else 'ban' end;

  select audit.id, audit.outcome into audit_id, existing_outcome
  from public.master_audit_log audit
  where audit.actor_id = p_actor_id and audit.target_ref = p_target_user_id and audit.action = audit_action
  order by audit.created_at desc limit 1;
  existing_action := audit_action;

  select profile.account_role::text, profile.account_status::text, auth_user.email_confirmed_at
    into target_role, target_status, target_confirmed_at
  from public.profiles profile
  join auth.users auth_user on auth_user.id = profile.id
  where profile.id = p_target_user_id
  for update of profile;

  if not found then
    if p_action = 'delete_permanently' and audit_id is not null and existing_outcome = 'started' then
      return jsonb_build_object('auditId', audit_id, 'authAction', desired_auth_action, 'retry', true, 'alreadyDeleted', true);
    end if;
    raise exception 'account not found' using errcode = 'P0002';
  end if;
  if target_role = 'master' then raise exception 'master accounts cannot be changed here' using errcode = '42501'; end if;

  select details.request_status, details.invite_id into request_status, invite_target
  from public.access_request_details details where details.user_id = p_target_user_id for update;

  if p_action = 'approve' and target_status = 'active' and request_status = 'approved'
     and audit_id is not null and existing_outcome in ('started', 'failed', 'needs_attention') then
    return jsonb_build_object('auditId', audit_id, 'authAction', desired_auth_action, 'retry', true);
  elsif p_action = 'reject' and target_status = 'disabled' and request_status = 'rejected'
     and audit_id is not null and existing_outcome in ('started', 'failed', 'needs_attention') then
    return jsonb_build_object('auditId', audit_id, 'authAction', desired_auth_action, 'retry', true);
  elsif p_action = 'disable' and target_status = 'disabled'
     and audit_id is not null and existing_outcome in ('started', 'failed', 'needs_attention') then
    return jsonb_build_object('auditId', audit_id, 'authAction', desired_auth_action, 'retry', true);
  elsif p_action = 'trash' and target_status = 'trashed'
     and audit_id is not null and existing_outcome in ('started', 'failed', 'needs_attention') then
    return jsonb_build_object('auditId', audit_id, 'authAction', desired_auth_action, 'retry', true);
  elsif p_action = 'restore' and target_status = 'active'
     and audit_id is not null and existing_outcome in ('started', 'failed', 'needs_attention') then
    return jsonb_build_object('auditId', audit_id, 'authAction', desired_auth_action, 'retry', true);
  elsif p_action = 'delete_permanently' and target_status = 'trashed'
     and audit_id is not null and existing_outcome in ('started', 'failed', 'needs_attention') then
    return jsonb_build_object('auditId', audit_id, 'authAction', desired_auth_action, 'retry', true);
  end if;

  if p_action in ('approve', 'reject') then
    if target_status <> 'pending' or request_status <> 'pending_review' or target_confirmed_at is null then
      raise exception 'verified pending request required' using errcode = '22023';
    end if;
    if p_action = 'approve' and invite_target is not null then
      select invitation.used_by, invitation.expires_at, invitation.revoked_at
        into invite_used_by, invite_expires, invite_revoked
      from public.access_invites invitation where invitation.id = invite_target for update;
      if not found or invite_revoked is not null or invite_expires <= now()
         or (invite_used_by is not null and invite_used_by <> p_target_user_id) then
        raise exception 'linked invite unavailable' using errcode = '22023';
      end if;
      update public.access_invites set used_by = p_target_user_id, used_at = now()
      where id = invite_target and used_by is null;
    end if;
    update public.access_request_details
    set request_status = case when p_action = 'approve' then 'approved' else 'rejected' end,
        decided_at = now(), decided_by = p_actor_id
    where user_id = p_target_user_id;
    update public.profiles
    set account_status = case when p_action = 'approve' then 'active'::public.account_status else 'disabled'::public.account_status end,
        disabled_at = case when p_action = 'approve' then null else now() end,
        trashed_at = null
    where id = p_target_user_id;
  elsif p_action = 'disable' then
    if target_status <> 'active' then raise exception 'only active accounts can be disabled' using errcode = '22023'; end if;
    update public.profiles set account_status = 'disabled', disabled_at = now(), trashed_at = null where id = p_target_user_id;
  elsif p_action = 'trash' then
    if target_status not in ('active', 'disabled') then raise exception 'account cannot be moved to trash from this state' using errcode = '22023'; end if;
    update public.profiles set account_status = 'trashed', trashed_at = now() where id = p_target_user_id;
  elsif p_action = 'restore' then
    if target_status not in ('disabled', 'trashed') or request_status = 'rejected' then
      raise exception 'only disabled or trashed accounts can be restored' using errcode = '22023';
    end if;
    update public.profiles set account_status = 'active', disabled_at = null, trashed_at = null where id = p_target_user_id;
  elsif p_action = 'delete_permanently' then
    if target_status <> 'trashed' then raise exception 'account must be in trash before permanent deletion' using errcode = '22023'; end if;
  end if;

  insert into public.master_audit_log(
    actor_id, target_user_id, target_ref, invite_id, action, reason_code, reason_note, outcome
  ) values (
    p_actor_id, p_target_user_id, p_target_user_id, invite_target, audit_action,
    p_reason_code, note, 'started'
  ) returning id into audit_id;

  return jsonb_build_object('auditId', audit_id, 'authAction', desired_auth_action, 'retry', false);
end;
$$;

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
  if p_detail_code is not null and p_detail_code not in ('auth_ban_failed', 'auth_unban_failed', 'auth_delete_failed') then
    raise exception 'invalid audit detail' using errcode = '22023';
  end if;
  update public.master_audit_log
  set outcome = p_outcome, detail_code = p_detail_code
  where id = p_audit_id and actor_id = p_actor_id and outcome = 'started';
  return found;
end;
$$;

create or replace function public.master_list_access_invites(
  p_actor_id uuid,
  p_page integer default 1,
  p_page_size integer default 25
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare
  safe_page integer := greatest(coalesce(p_page, 1), 1);
  safe_page_size integer := least(greatest(coalesce(p_page_size, 25), 1), 100);
  result jsonb;
begin
  if not exists (select 1 from public.profiles where id = p_actor_id and account_role = 'master' and account_status = 'active') then
    raise exception 'master authorization required' using errcode = '42501';
  end if;
  select jsonb_build_object(
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', invitation.id,
        'token', invitation.token,
        'createdAt', invitation.created_at,
        'expiresAt', invitation.expires_at,
        'usedAt', invitation.used_at,
        'usedByName', used_profile.full_name,
        'revokedAt', invitation.revoked_at,
        'status', case
          when invitation.revoked_at is not null then 'revoked'
          when invitation.used_by is not null then 'used'
          when invitation.expires_at <= now() then 'expired'
          else 'active'
        end
      ) order by invitation.created_at desc)
      from (
        select * from public.access_invites
        where created_by = p_actor_id
        order by created_at desc
        limit safe_page_size offset (safe_page - 1) * safe_page_size
      ) invitation
      left join public.profiles used_profile on used_profile.id = invitation.used_by
    ), '[]'::jsonb),
    'total', (select count(*) from public.access_invites where created_by = p_actor_id),
    'page', safe_page,
    'pageSize', safe_page_size
  ) into result;
  return result;
end;
$$;

create or replace function public.master_create_access_invite(p_actor_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare
  created_invite public.access_invites%rowtype;
begin
  if not exists (select 1 from public.profiles where id = p_actor_id and account_role = 'master' and account_status = 'active') then
    raise exception 'master authorization required' using errcode = '42501';
  end if;
  insert into public.access_invites(created_by) values (p_actor_id) returning * into created_invite;
  insert into public.master_audit_log(actor_id, invite_id, action, outcome)
  values (p_actor_id, created_invite.id, 'invite_created', 'completed');
  return jsonb_build_object(
    'id', created_invite.id,
    'token', created_invite.token,
    'createdAt', created_invite.created_at,
    'expiresAt', created_invite.expires_at,
    'status', 'active'
  );
end;
$$;

create or replace function public.master_revoke_access_invite(p_actor_id uuid, p_invite_id uuid)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare
  invite public.access_invites%rowtype;
begin
  if not exists (select 1 from public.profiles where id = p_actor_id and account_role = 'master' and account_status = 'active') then
    raise exception 'master authorization required' using errcode = '42501';
  end if;
  select * into invite from public.access_invites
  where id = p_invite_id and created_by = p_actor_id for update;
  if not found then raise exception 'invite not found' using errcode = 'P0002'; end if;
  if invite.revoked_at is not null or invite.used_by is not null or invite.expires_at <= now() then
    raise exception 'invite cannot be revoked' using errcode = '22023';
  end if;
  update public.access_invites set revoked_at = now(), revoked_by = p_actor_id where id = p_invite_id;
  insert into public.master_audit_log(actor_id, invite_id, action, outcome)
  values (p_actor_id, p_invite_id, 'invite_revoked', 'completed');
  return true;
end;
$$;

create or replace function public.master_list_audit(
  p_actor_id uuid,
  p_page integer default 1,
  p_page_size integer default 25,
  p_action text default null
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
  safe_action text := nullif(trim(coalesce(p_action, '')), '');
  result jsonb;
begin
  if not exists (select 1 from public.profiles where id = p_actor_id and account_role = 'master' and account_status = 'active') then
    raise exception 'master authorization required' using errcode = '42501';
  end if;
  if safe_action is not null and safe_action not in (
    'approved', 'rejected', 'disabled', 'restored', 'trashed', 'permanently_deleted', 'invite_created', 'invite_revoked'
  ) then raise exception 'invalid audit filter' using errcode = '22023'; end if;
  with filtered as (
    select
      audit.id,
      audit.action,
      audit.outcome,
      audit.reason_code,
      audit.reason_note,
      audit.detail_code,
      audit.created_at,
      audit.target_ref,
      audit.invite_id,
      actor.full_name as actor_name,
      actor_auth.email as actor_email,
      coalesce(target.full_name, target_auth.email, case when audit.target_ref is not null then 'Conta excluída' end) as target_name,
      target_auth.email as target_email
    from public.master_audit_log audit
    join auth.users actor_auth on actor_auth.id = audit.actor_id
    left join public.profiles actor on actor.id = audit.actor_id
    left join auth.users target_auth on target_auth.id = audit.target_ref
    left join public.profiles target on target.id = audit.target_ref
    where audit.actor_id = p_actor_id and (safe_action is null or audit.action = safe_action)
  ), page_rows as (
    select * from filtered order by created_at desc, id desc
    limit safe_page_size offset (safe_page - 1) * safe_page_size
  )
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(to_jsonb(page_rows) order by created_at desc, id desc) from page_rows), '[]'::jsonb),
    'total', (select count(*) from filtered),
    'page', safe_page,
    'pageSize', safe_page_size
  ) into result;
  return result;
end;
$$;

revoke all on function public.master_list_accounts(text, text, integer, integer) from public, anon, authenticated;
revoke all on function public.master_transition_account(uuid, uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.master_finish_admin_audit(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.master_list_access_invites(uuid, integer, integer) from public, anon, authenticated;
revoke all on function public.master_create_access_invite(uuid) from public, anon, authenticated;
revoke all on function public.master_revoke_access_invite(uuid, uuid) from public, anon, authenticated;
revoke all on function public.master_list_audit(uuid, integer, integer, text) from public, anon, authenticated;
grant execute on function public.master_list_accounts(text, text, integer, integer) to service_role;
grant execute on function public.master_transition_account(uuid, uuid, text, text, text) to service_role;
grant execute on function public.master_finish_admin_audit(uuid, uuid, text, text) to service_role;
grant execute on function public.master_list_access_invites(uuid, integer, integer) to service_role;
grant execute on function public.master_create_access_invite(uuid) to service_role;
grant execute on function public.master_revoke_access_invite(uuid, uuid) to service_role;
grant execute on function public.master_list_audit(uuid, integer, integer, text) to service_role;

notify pgrst, 'reload schema';
