-- Keep the Master request queue globally paginated across all request states.
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
        when profile.account_status = 'trashed' then 'trashed'
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

-- Serialize retries and retain a separate audit row for each provider attempt.
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
  existing_reason_code text;
  existing_reason_note text;
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

  -- Lock the account first; all competing actions for this user serialize here.
  select profile.account_role::text, profile.account_status::text, auth_user.email_confirmed_at
    into target_role, target_status, target_confirmed_at
  from public.profiles profile
  join auth.users auth_user on auth_user.id = profile.id
  where profile.id = p_target_user_id
  for update of profile;

  if not found then
    if p_action = 'delete_permanently' then
      select audit.id, audit.outcome into audit_id, existing_outcome
      from public.master_audit_log audit
      where audit.actor_id = p_actor_id and audit.target_ref = p_target_user_id and audit.action = audit_action
      order by audit.created_at desc, audit.id desc
      limit 1
      for update;
      if audit_id is not null and existing_outcome = 'completed' then
        return jsonb_build_object('auditId', audit_id, 'alreadyCompleted', true);
      elsif audit_id is not null and existing_outcome in ('started', 'failed', 'needs_attention') then
        if existing_outcome <> 'started' then
          update public.master_audit_log set outcome = 'started', detail_code = null
          where id = audit_id and actor_id = p_actor_id;
        end if;
        return jsonb_build_object('auditId', audit_id, 'authAction', desired_auth_action, 'retry', true, 'alreadyDeleted', true);
      end if;
    end if;
    raise exception 'account not found' using errcode = 'P0002';
  end if;
  if target_role = 'master' then raise exception 'master accounts cannot be changed here' using errcode = '42501'; end if;

  select details.request_status, details.invite_id into request_status, invite_target
  from public.access_request_details details where details.user_id = p_target_user_id for update;

  select audit.id, audit.outcome, audit.reason_code, audit.reason_note
    into audit_id, existing_outcome, existing_reason_code, existing_reason_note
  from public.master_audit_log audit
  where audit.actor_id = p_actor_id and audit.target_ref = p_target_user_id and audit.action = audit_action
  order by audit.created_at desc, audit.id desc
  limit 1
  for update;

  if (p_action = 'approve' and target_status = 'active' and request_status = 'approved')
    or (p_action = 'reject' and target_status = 'disabled' and request_status = 'rejected')
    or (p_action = 'disable' and target_status = 'disabled')
    or (p_action = 'trash' and target_status = 'trashed')
    or (p_action = 'restore' and target_status = 'active') then
    if existing_outcome = 'started' then
      raise exception 'admin action already in progress' using errcode = '55P03';
    elsif existing_outcome = 'completed' then
      return jsonb_build_object('auditId', audit_id, 'alreadyCompleted', true);
    elsif existing_outcome in ('failed', 'needs_attention') then
      insert into public.master_audit_log(
        actor_id, target_user_id, target_ref, invite_id, action, reason_code, reason_note, outcome, created_at
      ) values (
        p_actor_id, p_target_user_id, p_target_user_id, invite_target, audit_action,
        coalesce(p_reason_code, existing_reason_code), coalesce(note, existing_reason_note), 'started', clock_timestamp()
      ) returning id into audit_id;
      return jsonb_build_object('auditId', audit_id, 'authAction', desired_auth_action, 'retry', true);
    end if;
  elsif p_action = 'delete_permanently' and target_status = 'trashed'
    and existing_outcome in ('started', 'failed', 'needs_attention') then
    if existing_outcome = 'started' then
      raise exception 'admin action already in progress' using errcode = '55P03';
    end if;
    insert into public.master_audit_log(
      actor_id, target_user_id, target_ref, invite_id, action, reason_code, reason_note, outcome, created_at
    ) values (
      p_actor_id, p_target_user_id, p_target_user_id, invite_target, audit_action,
      coalesce(p_reason_code, existing_reason_code), coalesce(note, existing_reason_note), 'started', clock_timestamp()
    ) returning id into audit_id;
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
    actor_id, target_user_id, target_ref, invite_id, action, reason_code, reason_note, outcome, created_at
  ) values (
    p_actor_id, p_target_user_id, p_target_user_id, invite_target, audit_action,
    p_reason_code, note, 'started', clock_timestamp()
  ) returning id into audit_id;

  return jsonb_build_object('auditId', audit_id, 'authAction', desired_auth_action, 'retry', false);
end;
$$;

create or replace function public.master_list_audit_filtered(
  p_actor_id uuid,
  p_page integer default 1,
  p_page_size integer default 25,
  p_action text default null,
  p_outcome text default null,
  p_since timestamptz default null,
  p_until timestamptz default null
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
  safe_outcome text := nullif(trim(coalesce(p_outcome, '')), '');
  result jsonb;
begin
  if not exists (select 1 from public.profiles where id = p_actor_id and account_role = 'master' and account_status = 'active') then
    raise exception 'master authorization required' using errcode = '42501';
  end if;
  if safe_action is not null and safe_action not in (
    'approved', 'rejected', 'disabled', 'restored', 'trashed', 'permanently_deleted', 'invite_created', 'invite_revoked'
  ) then raise exception 'invalid audit action filter' using errcode = '22023'; end if;
  if safe_outcome is not null and safe_outcome not in ('started', 'completed', 'failed', 'needs_attention') then
    raise exception 'invalid audit outcome filter' using errcode = '22023';
  end if;
  if p_since is not null and p_until is not null and p_since >= p_until then
    raise exception 'invalid audit date range' using errcode = '22023';
  end if;

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
    where audit.actor_id = p_actor_id
      and (safe_action is null or audit.action = safe_action)
      and (safe_outcome is null or audit.outcome = safe_outcome)
      and (p_since is null or audit.created_at >= p_since)
      and (p_until is null or audit.created_at < p_until)
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

revoke all on function public.master_list_audit_filtered(uuid, integer, integer, text, text, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.master_list_audit_filtered(uuid, integer, integer, text, text, timestamptz, timestamptz) to service_role;

notify pgrst, 'reload schema';
