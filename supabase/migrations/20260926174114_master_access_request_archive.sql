-- Preserve verified, undecided access requests when the Master archives them.
-- Archiving is reversible and never grants access or marks a request rejected.
begin;

create or replace function public.prevent_unapproved_request_activation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
begin
  if new.account_status = 'active' and exists (
    select 1
    from public.access_request_details request
    where request.user_id = new.id
      and request.request_status = 'pending_review'
  ) then
    raise exception 'pending access request must be reopened for review' using errcode = '22023';
  end if;
  return new;
end;
$$;

drop trigger if exists prevent_unapproved_request_activation on public.profiles;
create trigger prevent_unapproved_request_activation
before insert or update of account_status on public.profiles
for each row execute function public.prevent_unapproved_request_activation();

revoke all on function public.prevent_unapproved_request_activation() from public, anon, authenticated;

create or replace function public.master_archive_access_request(
  p_actor_id uuid,
  p_target_user_id uuid,
  p_reason_code text,
  p_reason_note text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, auth
set row_security = off
as $$
declare
  actor_is_master boolean;
  target_role text;
  target_status text;
  target_confirmed_at timestamptz;
  request_status text;
  invite_target uuid;
  audit_id uuid;
  existing_outcome text;
  note text := nullif(trim(coalesce(p_reason_note, '')), '');
begin
  select exists (
    select 1 from public.profiles
    where id = p_actor_id and account_role = 'master' and account_status = 'active'
  ) into actor_is_master;
  if not actor_is_master then raise exception 'master authorization required' using errcode = '42501'; end if;
  if p_target_user_id is null or p_target_user_id = p_actor_id then
    raise exception 'cannot manage own master account' using errcode = '42501';
  end if;
  if p_reason_code is null or p_reason_code not in (
    'duplicate_request', 'incomplete_request', 'policy_violation',
    'security_concern', 'user_requested', 'other'
  ) then raise exception 'reason code required' using errcode = '22023'; end if;
  if note is null or char_length(note) > 280 or note not like 'Solicitação confirmada arquivada:%' then
    raise exception 'archive reason required' using errcode = '22023';
  end if;

  select profile.account_role::text, profile.account_status::text, auth_user.email_confirmed_at
    into target_role, target_status, target_confirmed_at
  from public.profiles profile
  join auth.users auth_user on auth_user.id = profile.id
  where profile.id = p_target_user_id
  for update of profile;
  if not found then raise exception 'account not found' using errcode = 'P0002'; end if;
  if target_role = 'master' then raise exception 'master accounts cannot be changed here' using errcode = '42501'; end if;

  select details.request_status, details.invite_id
    into request_status, invite_target
  from public.access_request_details details
  where details.user_id = p_target_user_id
  for update;
  if not found or request_status <> 'pending_review' or target_confirmed_at is null then
    raise exception 'verified pending request required for archive' using errcode = '22023';
  end if;

  select audit.id, audit.outcome into audit_id, existing_outcome
  from public.master_audit_log audit
  where audit.actor_id = p_actor_id
    and audit.target_ref = p_target_user_id
    and audit.action = 'trashed'
    and audit.reason_note like 'Solicitação confirmada arquivada:%'
  order by audit.created_at desc, audit.id desc
  limit 1
  for update;

  if target_status = 'trashed' then
    if existing_outcome = 'completed' then
      return jsonb_build_object('auditId', audit_id, 'alreadyCompleted', true);
    elsif existing_outcome = 'started' then
      raise exception 'admin action already in progress' using errcode = '55P03';
    elsif existing_outcome in ('failed', 'needs_attention') then
      insert into public.master_audit_log(
        actor_id, target_user_id, target_ref, invite_id, action, reason_code, reason_note, outcome, created_at
      ) values (
        p_actor_id, p_target_user_id, p_target_user_id, invite_target, 'trashed',
        p_reason_code, note, 'started', clock_timestamp()
      ) returning id into audit_id;
      return jsonb_build_object('auditId', audit_id, 'authAction', 'ban', 'retry', true);
    end if;
  elsif target_status <> 'pending' then
    raise exception 'verified pending request required for archive' using errcode = '22023';
  end if;

  if target_status = 'pending' then
    update public.profiles
    set account_status = 'trashed', trashed_at = clock_timestamp(), disabled_at = null
    where id = p_target_user_id;
  end if;
  insert into public.master_audit_log(
    actor_id, target_user_id, target_ref, invite_id, action, reason_code, reason_note, outcome, created_at
  ) values (
    p_actor_id, p_target_user_id, p_target_user_id, invite_target, 'trashed',
    p_reason_code, note, 'started', clock_timestamp()
  ) returning id into audit_id;
  return jsonb_build_object('auditId', audit_id, 'authAction', 'ban', 'retry', false);
end;
$$;

create or replace function public.master_reopen_access_request(
  p_actor_id uuid,
  p_target_user_id uuid,
  p_reason_code text,
  p_reason_note text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, auth
set row_security = off
as $$
declare
  actor_is_master boolean;
  target_role text;
  target_status text;
  target_confirmed_at timestamptz;
  request_status text;
  invite_target uuid;
  audit_id uuid;
  existing_outcome text;
  note text := nullif(trim(coalesce(p_reason_note, '')), '');
begin
  select exists (
    select 1 from public.profiles
    where id = p_actor_id and account_role = 'master' and account_status = 'active'
  ) into actor_is_master;
  if not actor_is_master then raise exception 'master authorization required' using errcode = '42501'; end if;
  if p_target_user_id is null or p_target_user_id = p_actor_id then
    raise exception 'cannot manage own master account' using errcode = '42501';
  end if;
  if p_reason_code is null or p_reason_code not in (
    'duplicate_request', 'incomplete_request', 'policy_violation',
    'security_concern', 'user_requested', 'other'
  ) then raise exception 'reason code required' using errcode = '22023'; end if;
  if note is null or char_length(note) > 280 or note not like 'Solicitação arquivada reaberta:%' then
    raise exception 'reopen reason required' using errcode = '22023';
  end if;

  select profile.account_role::text, profile.account_status::text, auth_user.email_confirmed_at
    into target_role, target_status, target_confirmed_at
  from public.profiles profile
  join auth.users auth_user on auth_user.id = profile.id
  where profile.id = p_target_user_id
  for update of profile;
  if not found then raise exception 'account not found' using errcode = 'P0002'; end if;
  if target_role = 'master' then raise exception 'master accounts cannot be changed here' using errcode = '42501'; end if;

  select details.request_status, details.invite_id
    into request_status, invite_target
  from public.access_request_details details
  where details.user_id = p_target_user_id
  for update;
  if not found or request_status <> 'pending_review' or target_confirmed_at is null then
    raise exception 'archived access request required' using errcode = '22023';
  end if;

  select audit.id, audit.outcome into audit_id, existing_outcome
  from public.master_audit_log audit
  where audit.actor_id = p_actor_id
    and audit.target_ref = p_target_user_id
    and audit.action = 'restored'
    and audit.reason_note like 'Solicitação arquivada reaberta:%'
  order by audit.created_at desc, audit.id desc
  limit 1
  for update;

  if target_status = 'pending' then
    if existing_outcome = 'completed' then
      return jsonb_build_object('auditId', audit_id, 'alreadyCompleted', true);
    elsif existing_outcome = 'started' then
      raise exception 'admin action already in progress' using errcode = '55P03';
    elsif existing_outcome in ('failed', 'needs_attention') then
      insert into public.master_audit_log(
        actor_id, target_user_id, target_ref, invite_id, action, reason_code, reason_note, outcome, created_at
      ) values (
        p_actor_id, p_target_user_id, p_target_user_id, invite_target, 'restored',
        p_reason_code, note, 'started', clock_timestamp()
      ) returning id into audit_id;
      return jsonb_build_object('auditId', audit_id, 'authAction', 'unban', 'retry', true);
    end if;
    raise exception 'archived access request required' using errcode = '22023';
  elsif target_status <> 'trashed' then
    raise exception 'archived access request required' using errcode = '22023';
  end if;

  update public.profiles
  set account_status = 'pending', trashed_at = null, disabled_at = null
  where id = p_target_user_id;
  insert into public.master_audit_log(
    actor_id, target_user_id, target_ref, invite_id, action, reason_code, reason_note, outcome, created_at
  ) values (
    p_actor_id, p_target_user_id, p_target_user_id, invite_target, 'restored',
    p_reason_code, note, 'started', clock_timestamp()
  ) returning id into audit_id;
  return jsonb_build_object('auditId', audit_id, 'authAction', 'unban', 'retry', false);
end;
$$;

revoke all on function public.master_archive_access_request(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.master_reopen_access_request(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.master_archive_access_request(uuid, uuid, text, text) to service_role;
grant execute on function public.master_reopen_access_request(uuid, uuid, text, text) to service_role;

commit;
