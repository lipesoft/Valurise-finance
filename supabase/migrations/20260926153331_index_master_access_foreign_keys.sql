-- Cover administrative foreign keys used by request, invite, and audit records.
create index if not exists access_invites_revoked_by_idx
  on public.access_invites(revoked_by);

create index if not exists access_request_details_decided_by_idx
  on public.access_request_details(decided_by);

create index if not exists access_request_details_invite_id_idx
  on public.access_request_details(invite_id);

create index if not exists master_audit_log_invite_id_idx
  on public.master_audit_log(invite_id);
