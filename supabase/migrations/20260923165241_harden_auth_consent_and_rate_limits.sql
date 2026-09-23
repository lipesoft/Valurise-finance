-- Additive hardening for public access requests, legal-versioned consent, and
-- API-exposed SECURITY DEFINER functions. This migration is safe to re-run.

alter table public.user_consents
  add column if not exists privacy_version text,
  add column if not exists terms_version text,
  add column if not exists cookie_policy_version text,
  add column if not exists ai_data_sharing_version text,
  add column if not exists ai_data_sharing_accepted_at timestamptz,
  add column if not exists ai_data_sharing_revoked_at timestamptz;

-- Never allow browser roles to invoke account-bootstrap or role-escalation
-- functions. The auth trigger continues to run through its database trigger.
revoke all on function public.handle_valurise_user_created() from public, anon, authenticated;
revoke all on function public.promote_valurise_master(text) from public, anon, authenticated;
grant execute on function public.promote_valurise_master(text) to service_role;

-- Invite redemption is only meaningful for the authenticated invitee.
revoke all on function public.redeem_access_invite(uuid) from public, anon;
grant execute on function public.redeem_access_invite(uuid) to authenticated;

-- Helpers used by RLS remain available to authenticated requests only.
revoke all on function public.current_user_is_active() from public, anon;
revoke all on function public.current_user_is_master() from public, anon;
grant execute on function public.current_user_is_active(), public.current_user_is_master() to authenticated;

-- Public ID generators do not need to be callable as RPC endpoints. Their
-- defaults/triggers execute as their owner, which retains implicit privileges.
create or replace function public.lume_public_id()
returns text language sql volatile set search_path = pg_catalog
as $$ select 'LUME-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)); $$;
create or replace function public.valurise_public_id()
returns text language sql volatile set search_path = pg_catalog
as $$ select 'VAL-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)); $$;
revoke all on function public.lume_public_id() from public, anon, authenticated;
revoke all on function public.valurise_public_id() from public, anon, authenticated;

-- Database-backed limits work across Vercel instances (unlike an in-memory
-- counter). Only the server's service_role may query or mutate this table.
create table if not exists public.public_rate_limits (
  bucket_key text primary key check (char_length(bucket_key) = 64),
  hits integer not null check (hits > 0),
  window_started_at timestamptz not null,
  expires_at timestamptz not null
);
create index if not exists public_rate_limits_expires_at_idx
  on public.public_rate_limits (expires_at);
alter table public.public_rate_limits enable row level security;
revoke all on table public.public_rate_limits from public, anon, authenticated;
grant all on table public.public_rate_limits to service_role;

create or replace function public.consume_public_rate_limit(
  p_key text,
  p_max_attempts integer,
  p_window_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  current_hits integer;
  current_time timestamptz := clock_timestamp();
begin
  if p_key is null or char_length(p_key) <> 64
     or p_max_attempts not between 1 and 50
     or p_window_seconds not between 60 and 86400 then
    raise exception 'invalid rate-limit parameters';
  end if;

  insert into public.public_rate_limits (bucket_key, hits, window_started_at, expires_at)
  values (p_key, 1, current_time, current_time + make_interval(secs => p_window_seconds))
  on conflict (bucket_key) do update
  set hits = case
        when public.public_rate_limits.window_started_at <= current_time - make_interval(secs => p_window_seconds) then 1
        else public.public_rate_limits.hits + 1
      end,
      window_started_at = case
        when public.public_rate_limits.window_started_at <= current_time - make_interval(secs => p_window_seconds) then current_time
        else public.public_rate_limits.window_started_at
      end,
      expires_at = current_time + make_interval(secs => p_window_seconds)
  returning hits into current_hits;

  if random() < 0.02 then
    delete from public.public_rate_limits where expires_at < current_time;
  end if;

  return current_hits <= p_max_attempts;
end;
$$;
revoke all on function public.consume_public_rate_limit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.consume_public_rate_limit(text, integer, integer) to service_role;

-- Cover foreign keys that are traversed by deletes and common account-scoped
-- lookups. These tables are currently small; names are stable and idempotent.
create index if not exists accounts_user_id_idx on public.accounts (user_id);
create index if not exists budgets_category_id_idx on public.budgets (category_id);
create index if not exists credit_cards_institution_id_idx on public.credit_cards (institution_id);
create index if not exists goals_user_id_idx on public.goals (user_id);
create index if not exists master_audit_log_target_user_id_idx on public.master_audit_log (target_user_id);
create index if not exists shared_goal_contributions_account_id_idx on public.shared_goal_contributions (account_id);
create index if not exists shared_goal_contributions_user_id_idx on public.shared_goal_contributions (user_id);
create index if not exists shared_goal_invites_inviter_id_idx on public.shared_goal_invites (inviter_id);
create index if not exists shared_goals_owner_id_idx on public.shared_goals (owner_id);
create index if not exists transactions_account_id_idx on public.transactions (account_id);
create index if not exists transactions_category_id_idx on public.transactions (category_id);
create index if not exists transactions_destination_account_id_idx on public.transactions (destination_account_id);
