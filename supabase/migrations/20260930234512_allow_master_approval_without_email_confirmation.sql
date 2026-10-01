-- New registrations no longer need to confirm their email before Master review.
-- The user remains banned until the audited Master approval is completed.
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
  select profile.account_role::text, profile.account_status::text
    into target_role, target_status
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
    -- A real, still-pending access request is required, but email confirmation is not.
    if target_status <> 'pending' or request_status is null
       or request_status not in ('pending_review', 'pending_email', 'verification_required') then
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
