begin;

-- Idempotency for AI-created proposals: one proposal per confirmed request id.
alter table public.personal_ai_action_proposals add column if not exists request_id uuid;
create unique index if not exists personal_ai_action_proposals_request_id_uidx
  on public.personal_ai_action_proposals(request_id) where request_id is not null;

-- Central Val AI: additive migration. Existing per-workspace encrypted BYOK
-- values stay intact for rollback/audit, but the new product path does not read them.
alter table public.personal_ai_connections
  alter column provider drop not null,
  alter column encrypted_api_key drop not null,
  alter column model drop not null;
alter table public.personal_ai_connections
  drop constraint if exists personal_ai_connections_central_settings_check;
alter table public.personal_ai_connections
  add constraint personal_ai_connections_central_settings_check
  check ((provider is null and encrypted_api_key is null and model is null)
      or (provider is not null and encrypted_api_key is not null and model is not null)) not valid;
alter table public.personal_ai_connections
  validate constraint personal_ai_connections_central_settings_check;

create table if not exists public.val_ai_providers (
  id text primary key check (id in ('groq','openrouter')),
  enabled boolean not null default false,
  free_tier_confirmed boolean not null default false,
  health_status text not null default 'DISABLED'
    check (health_status in ('HEALTHY','DEGRADED','UNAVAILABLE','CIRCUIT_OPEN','HALF_OPEN','DISABLED','QUOTA_EXHAUSTED')),
  priority smallint not null default 100 check (priority between 1 and 1000),
  last_health_check timestamptz,
  last_latency_ms integer check (last_latency_ms is null or last_latency_ms between 0 and 120000),
  last_error_category text,
  last_error_code text,
  quota_headers jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.val_ai_provider_keys (
  id uuid primary key default gen_random_uuid(),
  provider_id text not null references public.val_ai_providers(id) on delete cascade,
  encrypted_api_key text not null,
  key_suffix text not null check (key_suffix ~ '^[A-Za-z0-9]{4}$'),
  is_active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists val_ai_one_active_key_per_provider_idx
  on public.val_ai_provider_keys(provider_id) where is_active;

create table if not exists public.val_ai_models (
  id uuid primary key default gen_random_uuid(),
  provider_id text not null references public.val_ai_providers(id) on delete cascade,
  model_id text not null check (char_length(model_id) between 2 and 150 and model_id ~ '^[A-Za-z0-9._:/-]+$'),
  display_name text not null check (char_length(display_name) between 1 and 160),
  is_free boolean not null default false,
  free_verified boolean not null default false,
  free_evidence text,
  is_enabled boolean not null default false,
  priority smallint not null default 100 check (priority between 1 and 1000),
  supports_chat boolean not null default true,
  supports_tools boolean not null default false,
  supports_structured_output boolean not null default false,
  supports_reasoning boolean not null default false,
  supports_streaming boolean not null default true,
  context_window integer check (context_window is null or context_window between 1 and 2000000),
  health_status text not null default 'UNAVAILABLE'
    check (health_status in ('HEALTHY','DEGRADED','UNAVAILABLE','CIRCUIT_OPEN','HALF_OPEN','DISABLED','QUOTA_EXHAUSTED')),
  last_health_check timestamptz,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  last_latency_ms integer check (last_latency_ms is null or last_latency_ms between 0 and 120000),
  failure_count integer not null default 0 check (failure_count >= 0),
  last_error_category text,
  last_error_code text,
  circuit_open_until timestamptz,
  official_prompt_price numeric(18,12),
  official_completion_price numeric(18,12),
  daily_request_limit integer check (daily_request_limit is null or daily_request_limit >= 0),
  monthly_request_limit integer check (monthly_request_limit is null or monthly_request_limit >= 0),
  daily_token_limit bigint check (daily_token_limit is null or daily_token_limit >= 0),
  monthly_token_limit bigint check (monthly_token_limit is null or monthly_token_limit >= 0),
  catalog_seen_at timestamptz,
  updated_at timestamptz not null default now(),
  unique(provider_id, model_id),
  constraint val_ai_model_paid_cannot_be_enabled check (not is_enabled or (is_free and free_verified and supports_chat)),
  constraint val_ai_openrouter_free_requires_zero_official_price check (
    provider_id <> 'openrouter' or not (is_free and free_verified)
    or (official_prompt_price = 0 and official_completion_price = 0)
  )
);
create index if not exists val_ai_models_router_idx
  on public.val_ai_models(provider_id, is_enabled, health_status, priority);

create table if not exists public.val_ai_runtime_settings (
  id smallint primary key default 1 check (id = 1),
  val_enabled boolean not null default false,
  val_groq_enabled boolean not null default false,
  val_openrouter_enabled boolean not null default false,
  val_router_enabled boolean not null default false,
  val_actions_enabled boolean not null default true,
  val_insights_enabled boolean not null default true,
  daily_requests integer not null default 10 check (daily_requests between 0 and 10000),
  monthly_requests integer not null default 200 check (monthly_requests between 0 and 100000),
  daily_tokens bigint not null default 50000 check (daily_tokens between 0 and 100000000),
  monthly_tokens bigint not null default 1000000 check (monthly_tokens between 0 and 1000000000),
  max_context_tokens integer not null default 12000 check (max_context_tokens between 2000 and 1000000),
  max_output_tokens integer not null default 700 check (max_output_tokens between 16 and 32000),
  max_attempts smallint not null default 2 check (max_attempts between 1 and 3),
  circuit_failure_threshold smallint not null default 3 check (circuit_failure_threshold between 1 and 20),
  circuit_cooldown_seconds integer not null default 120 check (circuit_cooldown_seconds between 10 and 86400),
  soft_quota_percent smallint not null default 80 check (soft_quota_percent between 1 and 99),
  deprioritize_quota_percent smallint not null default 90 check (deprioritize_quota_percent between 2 and 99),
  hard_quota_percent smallint not null default 98 check (hard_quota_percent between 50 and 100),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  constraint val_ai_quota_threshold_order check (soft_quota_percent < deprioritize_quota_percent and deprioritize_quota_percent < hard_quota_percent)
);
insert into public.val_ai_runtime_settings(id) values (1) on conflict (id) do nothing;

create table if not exists public.val_ai_user_preferences (
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  actions_enabled boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key(user_id, workspace_id)
);

create table if not exists public.val_ai_user_quota_overrides (
  user_id uuid primary key references auth.users(id) on delete cascade,
  is_blocked boolean not null default false,
  daily_requests integer check (daily_requests is null or daily_requests between 0 and 10000),
  monthly_requests integer check (monthly_requests is null or monthly_requests between 0 and 100000),
  daily_tokens bigint check (daily_tokens is null or daily_tokens between 0 and 100000000),
  monthly_tokens bigint check (monthly_tokens is null or monthly_tokens between 0 and 1000000000),
  max_context_tokens integer check (max_context_tokens is null or max_context_tokens between 2000 and 1000000),
  max_output_tokens integer check (max_output_tokens is null or max_output_tokens between 16 and 32000),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

create table if not exists public.val_ai_user_quota_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  period_kind text not null check (period_kind in ('day','month')),
  period_start date not null,
  requests integer not null default 0 check (requests >= 0),
  tokens bigint not null default 0 check (tokens >= 0),
  reserved_tokens bigint not null default 0 check (reserved_tokens >= 0),
  updated_at timestamptz not null default now(),
  primary key(user_id, period_kind, period_start)
);

create table if not exists public.val_ai_quota_reservations (
  request_id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  day_start date not null,
  month_start date not null,
  reserved_tokens bigint not null check (reserved_tokens >= 0),
  expires_at timestamptz not null,
  released_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists val_ai_quota_reservations_expiry_idx on public.val_ai_quota_reservations(user_id,expires_at) where released_at is null;

create table if not exists public.val_ai_usage_events (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  provider_id text references public.val_ai_providers(id),
  model_id text,
  task_type text not null check (task_type in ('GENERAL_CHAT','FINANCIAL_QUERY','FINANCIAL_ANALYSIS','STRUCTURED_RESPONSE','TOOL_CALL','ACTION_PROPOSAL','INSIGHT','LONG_CONTEXT')),
  attempt_index smallint not null check (attempt_index between 1 and 3),
  status text not null check (status in ('SUCCESS','FAILED','BLOCKED')),
  input_tokens integer check (input_tokens is null or input_tokens >= 0),
  output_tokens integer check (output_tokens is null or output_tokens >= 0),
  latency_ms integer not null check (latency_ms between 0 and 120000),
  error_category text,
  provider_code text,
  http_status integer check (http_status is null or http_status between 100 and 599),
  provider_request_id text,
  quota_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists val_ai_usage_events_created_idx on public.val_ai_usage_events(created_at desc);
create index if not exists val_ai_usage_events_user_created_idx on public.val_ai_usage_events(user_id, created_at desc);
create index if not exists val_ai_usage_events_provider_model_idx on public.val_ai_usage_events(provider_id, model_id, created_at desc);

create table if not exists public.val_ai_usage_rollups (
  period_kind text not null check (period_kind in ('day','month')),
  period_start date not null,
  provider_id text not null references public.val_ai_providers(id),
  model_id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  requests integer not null default 0 check (requests >= 0),
  attempts integer not null default 0 check (attempts >= 0),
  successes integer not null default 0 check (successes >= 0),
  failures integer not null default 0 check (failures >= 0),
  fallbacks integer not null default 0 check (fallbacks >= 0),
  input_tokens bigint not null default 0 check (input_tokens >= 0),
  output_tokens bigint not null default 0 check (output_tokens >= 0),
  latency_total_ms bigint not null default 0 check (latency_total_ms >= 0),
  updated_at timestamptz not null default now(),
  primary key(period_kind, period_start, provider_id, model_id, user_id)
);
create index if not exists val_ai_usage_rollups_provider_idx on public.val_ai_usage_rollups(period_kind, period_start desc, provider_id, model_id);
create index if not exists val_ai_usage_rollups_user_idx on public.val_ai_usage_rollups(user_id, period_kind, period_start desc);

create table if not exists public.val_ai_admin_audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid not null references auth.users(id) on delete restrict,
  action text not null check (char_length(action) between 1 and 80),
  provider_id text references public.val_ai_providers(id),
  model_id text,
  target_user_id uuid references auth.users(id) on delete set null,
  outcome text not null check (outcome in ('completed','failed')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists val_ai_admin_audit_created_idx on public.val_ai_admin_audit_log(created_at desc);

alter table public.val_ai_providers enable row level security;
alter table public.val_ai_provider_keys enable row level security;
alter table public.val_ai_models enable row level security;
alter table public.val_ai_runtime_settings enable row level security;
alter table public.val_ai_user_preferences enable row level security;
alter table public.val_ai_user_quota_overrides enable row level security;
alter table public.val_ai_user_quota_usage enable row level security;
alter table public.val_ai_quota_reservations enable row level security;
alter table public.val_ai_usage_events enable row level security;
alter table public.val_ai_usage_rollups enable row level security;
alter table public.val_ai_admin_audit_log enable row level security;
revoke all on public.val_ai_providers, public.val_ai_provider_keys, public.val_ai_models,
  public.val_ai_runtime_settings, public.val_ai_user_preferences, public.val_ai_user_quota_overrides,
  public.val_ai_user_quota_usage, public.val_ai_quota_reservations, public.val_ai_usage_events, public.val_ai_usage_rollups,
  public.val_ai_admin_audit_log from public, anon, authenticated;
grant all on public.val_ai_providers, public.val_ai_provider_keys, public.val_ai_models,
  public.val_ai_runtime_settings, public.val_ai_user_preferences, public.val_ai_user_quota_overrides,
  public.val_ai_user_quota_usage, public.val_ai_quota_reservations, public.val_ai_usage_events, public.val_ai_usage_rollups,
  public.val_ai_admin_audit_log to service_role;

create or replace function public.reserve_val_ai_user_request(p_user_id uuid,p_request_id uuid,p_reserved_tokens bigint)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  settings_row public.val_ai_runtime_settings%rowtype;
  override_row public.val_ai_user_quota_overrides%rowtype;
  today_utc date := (clock_timestamp() at time zone 'UTC')::date;
  month_utc date := date_trunc('month', clock_timestamp() at time zone 'UTC')::date;
  day_requests integer;
  month_requests integer;
  day_tokens bigint;
  month_tokens bigint;
  day_limit integer;
  month_limit integer;
  day_token_limit bigint;
  month_token_limit bigint;
  expired_reservation public.val_ai_quota_reservations%rowtype;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'server authorization required' using errcode = '42501'; end if;
  select * into settings_row from public.val_ai_runtime_settings where id=1;
  select * into override_row from public.val_ai_user_quota_overrides where user_id=p_user_id;
  if coalesce(override_row.is_blocked,false) then return jsonb_build_object('allowed',false,'reason','USER_BLOCKED'); end if;
  day_limit := coalesce(override_row.daily_requests,settings_row.daily_requests);
  month_limit := coalesce(override_row.monthly_requests,settings_row.monthly_requests);
  day_token_limit := coalesce(override_row.daily_tokens,settings_row.daily_tokens);
  month_token_limit := coalesce(override_row.monthly_tokens,settings_row.monthly_tokens);
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text || 'day' || today_utc::text, 0));
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text || 'month' || month_utc::text, 0));
  if exists (select 1 from public.val_ai_quota_reservations where request_id=p_request_id and user_id=p_user_id) then
    return jsonb_build_object('allowed',false,'reason','DUPLICATE_REQUEST');
  end if;
  for expired_reservation in select * from public.val_ai_quota_reservations
    where user_id=p_user_id and released_at is null and expires_at <= clock_timestamp() for update
  loop
    update public.val_ai_user_quota_usage set reserved_tokens=greatest(0,reserved_tokens-expired_reservation.reserved_tokens),updated_at=clock_timestamp()
      where user_id=p_user_id and ((period_kind='day' and period_start=expired_reservation.day_start) or (period_kind='month' and period_start=expired_reservation.month_start));
    update public.val_ai_quota_reservations set released_at=clock_timestamp() where request_id=expired_reservation.request_id;
  end loop;
  select coalesce(requests,0),coalesce(tokens,0)+coalesce(reserved_tokens,0) into day_requests,day_tokens from public.val_ai_user_quota_usage where user_id=p_user_id and period_kind='day' and period_start=today_utc;
  select coalesce(requests,0),coalesce(tokens,0)+coalesce(reserved_tokens,0) into month_requests,month_tokens from public.val_ai_user_quota_usage where user_id=p_user_id and period_kind='month' and period_start=month_utc;
  day_requests := coalesce(day_requests,0); month_requests := coalesce(month_requests,0);
  day_tokens := coalesce(day_tokens,0); month_tokens := coalesce(month_tokens,0);
  if day_requests >= day_limit or month_requests >= month_limit then
    return jsonb_build_object('allowed',false,'reason','REQUEST_LIMIT','daily_remaining',greatest(0,day_limit-day_requests),'monthly_remaining',greatest(0,month_limit-month_requests));
  end if;
  if day_tokens + greatest(0,p_reserved_tokens) > day_token_limit or month_tokens + greatest(0,p_reserved_tokens) > month_token_limit then
    return jsonb_build_object('allowed',false,'reason','TOKEN_LIMIT','daily_remaining',greatest(0,day_limit-day_requests),'monthly_remaining',greatest(0,month_limit-month_requests));
  end if;
  insert into public.val_ai_user_quota_usage(user_id,period_kind,period_start,requests,reserved_tokens,updated_at) values (p_user_id,'day',today_utc,1,greatest(0,p_reserved_tokens),clock_timestamp())
    on conflict(user_id,period_kind,period_start) do update set requests=public.val_ai_user_quota_usage.requests+1,reserved_tokens=public.val_ai_user_quota_usage.reserved_tokens+excluded.reserved_tokens,updated_at=excluded.updated_at;
  insert into public.val_ai_user_quota_usage(user_id,period_kind,period_start,requests,reserved_tokens,updated_at) values (p_user_id,'month',month_utc,1,greatest(0,p_reserved_tokens),clock_timestamp())
    on conflict(user_id,period_kind,period_start) do update set requests=public.val_ai_user_quota_usage.requests+1,reserved_tokens=public.val_ai_user_quota_usage.reserved_tokens+excluded.reserved_tokens,updated_at=excluded.updated_at;
  insert into public.val_ai_quota_reservations(request_id,user_id,day_start,month_start,reserved_tokens,expires_at)
    values(p_request_id,p_user_id,today_utc,month_utc,greatest(0,p_reserved_tokens),clock_timestamp()+interval '5 minutes');
  return jsonb_build_object('allowed',true,'daily_remaining',greatest(0,day_limit-day_requests-1),'monthly_remaining',greatest(0,month_limit-month_requests-1),'daily_limit',day_limit,'monthly_limit',month_limit,'daily_period_start',today_utc,'monthly_period_start',month_utc);
end; $$;
revoke all on function public.reserve_val_ai_user_request(uuid,uuid,bigint) from public, anon, authenticated;
grant execute on function public.reserve_val_ai_user_request(uuid,uuid,bigint) to service_role;

create or replace function public.finalize_val_ai_user_request(p_user_id uuid,p_request_id uuid)
returns void language plpgsql security definer set search_path = pg_catalog, public as $$
declare reservation public.val_ai_quota_reservations%rowtype;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'server authorization required' using errcode = '42501'; end if;
  select * into reservation from public.val_ai_quota_reservations where user_id=p_user_id and request_id=p_request_id and released_at is null for update;
  if not found then return; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text || 'day' || reservation.day_start::text, 0));
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text || 'month' || reservation.month_start::text, 0));
  update public.val_ai_user_quota_usage set reserved_tokens=greatest(0,reserved_tokens-reservation.reserved_tokens),updated_at=clock_timestamp()
    where user_id=p_user_id and ((period_kind='day' and period_start=reservation.day_start) or (period_kind='month' and period_start=reservation.month_start));
  update public.val_ai_quota_reservations set released_at=clock_timestamp() where request_id=p_request_id;
end; $$;
revoke all on function public.finalize_val_ai_user_request(uuid,uuid) from public, anon, authenticated;
grant execute on function public.finalize_val_ai_user_request(uuid,uuid) to service_role;

create or replace function public.aggregate_val_ai_usage_event()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
declare d date := (new.created_at at time zone 'UTC')::date; m date := date_trunc('month',new.created_at at time zone 'UTC')::date;
begin
  perform pg_advisory_xact_lock(hashtextextended(new.user_id::text || 'day' || d::text, 0));
  perform pg_advisory_xact_lock(hashtextextended(new.user_id::text || 'month' || m::text, 0));
  insert into public.val_ai_user_quota_usage(user_id,period_kind,period_start,tokens,updated_at)
    values(new.user_id,'day',d,coalesce(new.input_tokens,0)+coalesce(new.output_tokens,0),new.created_at)
    on conflict(user_id,period_kind,period_start) do update set tokens=public.val_ai_user_quota_usage.tokens+excluded.tokens,updated_at=excluded.updated_at;
  insert into public.val_ai_user_quota_usage(user_id,period_kind,period_start,tokens,updated_at)
    values(new.user_id,'month',m,coalesce(new.input_tokens,0)+coalesce(new.output_tokens,0),new.created_at)
    on conflict(user_id,period_kind,period_start) do update set tokens=public.val_ai_user_quota_usage.tokens+excluded.tokens,updated_at=excluded.updated_at;
  if new.provider_id is null or new.model_id is null then return new; end if;
  insert into public.val_ai_usage_rollups(period_kind,period_start,provider_id,model_id,user_id,requests,attempts,successes,failures,fallbacks,input_tokens,output_tokens,latency_total_ms,updated_at)
    values('day',d,new.provider_id,new.model_id,new.user_id,case when new.attempt_index=1 then 1 else 0 end,1,case when new.status='SUCCESS' then 1 else 0 end,case when new.status='FAILED' then 1 else 0 end,case when new.attempt_index>1 then 1 else 0 end,coalesce(new.input_tokens,0),coalesce(new.output_tokens,0),new.latency_ms,new.created_at)
    on conflict(period_kind,period_start,provider_id,model_id,user_id) do update set requests=public.val_ai_usage_rollups.requests+excluded.requests,attempts=public.val_ai_usage_rollups.attempts+excluded.attempts,successes=public.val_ai_usage_rollups.successes+excluded.successes,failures=public.val_ai_usage_rollups.failures+excluded.failures,fallbacks=public.val_ai_usage_rollups.fallbacks+excluded.fallbacks,input_tokens=public.val_ai_usage_rollups.input_tokens+excluded.input_tokens,output_tokens=public.val_ai_usage_rollups.output_tokens+excluded.output_tokens,latency_total_ms=public.val_ai_usage_rollups.latency_total_ms+excluded.latency_total_ms,updated_at=excluded.updated_at;
  insert into public.val_ai_usage_rollups(period_kind,period_start,provider_id,model_id,user_id,requests,attempts,successes,failures,fallbacks,input_tokens,output_tokens,latency_total_ms,updated_at)
    values('month',m,new.provider_id,new.model_id,new.user_id,case when new.attempt_index=1 then 1 else 0 end,1,case when new.status='SUCCESS' then 1 else 0 end,case when new.status='FAILED' then 1 else 0 end,case when new.attempt_index>1 then 1 else 0 end,coalesce(new.input_tokens,0),coalesce(new.output_tokens,0),new.latency_ms,new.created_at)
    on conflict(period_kind,period_start,provider_id,model_id,user_id) do update set requests=public.val_ai_usage_rollups.requests+excluded.requests,attempts=public.val_ai_usage_rollups.attempts+excluded.attempts,successes=public.val_ai_usage_rollups.successes+excluded.successes,failures=public.val_ai_usage_rollups.failures+excluded.failures,fallbacks=public.val_ai_usage_rollups.fallbacks+excluded.fallbacks,input_tokens=public.val_ai_usage_rollups.input_tokens+excluded.input_tokens,output_tokens=public.val_ai_usage_rollups.output_tokens+excluded.output_tokens,latency_total_ms=public.val_ai_usage_rollups.latency_total_ms+excluded.latency_total_ms,updated_at=excluded.updated_at;
  return new;
end; $$;
revoke all on function public.aggregate_val_ai_usage_event() from public, anon, authenticated;
drop trigger if exists val_ai_usage_event_aggregate on public.val_ai_usage_events;
create trigger val_ai_usage_event_aggregate after insert on public.val_ai_usage_events for each row execute function public.aggregate_val_ai_usage_event();

create or replace function public.claim_val_ai_model_probe(p_provider_id text, p_model_id text)
returns boolean language plpgsql security definer set search_path = pg_catalog, public as $$
declare claimed uuid;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'server authorization required' using errcode = '42501'; end if;
  update public.val_ai_models set health_status='HALF_OPEN', circuit_open_until=clock_timestamp()+interval '30 seconds', updated_at=clock_timestamp()
    where provider_id=p_provider_id and model_id=p_model_id and is_enabled and is_free and free_verified
      and health_status='CIRCUIT_OPEN' and circuit_open_until <= clock_timestamp()
    returning id into claimed;
  return claimed is not null;
end; $$;
revoke all on function public.claim_val_ai_model_probe(text,text) from public, anon, authenticated;
grant execute on function public.claim_val_ai_model_probe(text,text) to service_role;

create or replace function public.record_val_ai_model_result(
  p_provider_id text, p_model_id text, p_success boolean, p_latency_ms integer,
  p_error_category text default null, p_error_code text default null, p_quota_headers jsonb default '{}'::jsonb
)
returns void language plpgsql security definer set search_path = pg_catalog, public as $$
declare threshold smallint; cooldown integer;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'server authorization required' using errcode = '42501'; end if;
  select circuit_failure_threshold,circuit_cooldown_seconds into threshold,cooldown from public.val_ai_runtime_settings where id=1;
  if p_success then
    update public.val_ai_models set health_status='HEALTHY',last_health_check=clock_timestamp(),last_success_at=clock_timestamp(),last_latency_ms=greatest(0,least(120000,p_latency_ms)),failure_count=0,circuit_open_until=null,updated_at=clock_timestamp() where provider_id=p_provider_id and model_id=p_model_id;
    update public.val_ai_providers set health_status='HEALTHY',last_health_check=clock_timestamp(),last_latency_ms=greatest(0,least(120000,p_latency_ms)),last_error_category=null,last_error_code=null,quota_headers=coalesce(p_quota_headers,'{}'::jsonb),updated_at=clock_timestamp() where id=p_provider_id;
  else
    update public.val_ai_models set failure_count=failure_count+1,last_health_check=clock_timestamp(),last_failure_at=clock_timestamp(),last_latency_ms=greatest(0,least(120000,p_latency_ms)),last_error_category=p_error_category,last_error_code=p_error_code,
      health_status=case when failure_count+1 >= coalesce(threshold,3) then 'CIRCUIT_OPEN' else 'DEGRADED' end,
      circuit_open_until=case when failure_count+1 >= coalesce(threshold,3) then clock_timestamp()+make_interval(secs=>coalesce(cooldown,120)) else null end,updated_at=clock_timestamp()
      where provider_id=p_provider_id and model_id=p_model_id;
    update public.val_ai_providers set health_status='DEGRADED',last_health_check=clock_timestamp(),last_latency_ms=greatest(0,least(120000,p_latency_ms)),last_error_category=p_error_category,last_error_code=p_error_code,quota_headers=coalesce(p_quota_headers,'{}'::jsonb),updated_at=clock_timestamp() where id=p_provider_id;
  end if;
end; $$;
revoke all on function public.record_val_ai_model_result(text,text,boolean,integer,text,text,jsonb) from public, anon, authenticated;
grant execute on function public.record_val_ai_model_result(text,text,boolean,integer,text,text,jsonb) to service_role;

-- Action confirmation is governed by the individual user's current Val consent
-- and action preference, not by the old workspace-wide BYOK connection row.
create or replace function public.confirm_workspace_ai_transaction(
  p_proposal_id uuid, p_user_id uuid, p_workspace_id uuid, p_expected_consent_version text
)
returns jsonb
language plpgsql security definer set search_path = pg_catalog, public set row_security = off
as $$
declare
  action_row public.personal_ai_action_proposals%rowtype;
  consent_row public.workspace_ai_consents%rowtype;
  financial_state jsonb;
  current_version integer;
  new_version integer;
  transaction_id text := gen_random_uuid()::text;
  transaction_row jsonb;
  actions_allowed boolean := false;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'server authorization required' using errcode = '42501'; end if;
  if not exists (select 1 from public.workspace_memberships membership join public.profiles profile on profile.id=membership.user_id
    where membership.workspace_id=p_workspace_id and membership.user_id=p_user_id and membership.role in ('owner','admin','finance')
      and membership.status='active' and profile.account_role='user' and profile.account_status='active') then
    raise exception 'workspace access denied' using errcode = '42501';
  end if;
  select * into action_row from public.personal_ai_action_proposals
    where id=p_proposal_id and user_id=p_user_id and workspace_id=p_workspace_id for update;
  if not found then raise exception 'proposal not found' using errcode = 'P0002'; end if;
  if action_row.status <> 'pending' then return jsonb_build_object('ok',false,'reason','not_pending'); end if;
  if action_row.expires_at <= clock_timestamp() then
    update public.personal_ai_action_proposals set status='expired',acted_at=clock_timestamp() where id=action_row.id;
    return jsonb_build_object('ok',false,'reason','expired');
  end if;
  select * into consent_row from public.workspace_ai_consents where workspace_id=p_workspace_id and user_id=p_user_id;
  select coalesce(preferences.actions_enabled,false) into actions_allowed from public.val_ai_user_preferences preferences
    where preferences.workspace_id=p_workspace_id and preferences.user_id=p_user_id;
  if not coalesce(actions_allowed,false) or consent_row.ai_data_sharing_version is distinct from p_expected_consent_version
     or action_row.consent_version is distinct from p_expected_consent_version or consent_row.accepted_at is null then
    update public.personal_ai_action_proposals set status='cancelled',acted_at=clock_timestamp() where id=action_row.id;
    return jsonb_build_object('ok',false,'reason','permission_revoked');
  end if;
  select financial.state,financial.version into financial_state,current_version from public.user_financial_state financial where financial.workspace_id=p_workspace_id for update;
  if not found then
    update public.personal_ai_action_proposals set status='stale',acted_at=clock_timestamp() where id=action_row.id;
    return jsonb_build_object('ok',false,'reason','state_missing');
  end if;
  if current_version <> action_row.expected_state_version then
    update public.personal_ai_action_proposals set status='stale',acted_at=clock_timestamp() where id=action_row.id;
    return jsonb_build_object('ok',false,'reason','state_changed');
  end if;
  if action_row.action_type not in ('income','expense')
    or action_row.transaction_date > (clock_timestamp() at time zone 'America/Sao_Paulo')::date
    or not exists (select 1 from jsonb_array_elements_text(case when jsonb_typeof(financial_state #> '{data,categories}')='array' then financial_state #> '{data,categories}' else '[]'::jsonb end) category(value) where category.value=action_row.category)
    or not exists (select 1 from jsonb_array_elements(case when jsonb_typeof(financial_state #> '{data,institutions}')='array' then financial_state #> '{data,institutions}' else '[]'::jsonb end) institution(value)
      cross join lateral jsonb_array_elements(case when jsonb_typeof(institution.value->'accounts')='array' then institution.value->'accounts' else '[]'::jsonb end) account(value)
      where coalesce(institution.value->>'name','') || ' • ' || coalesce(account.value->>'name','')=action_row.account_label
        and not exists (select 1 from jsonb_array_elements(case when jsonb_typeof(institution.value->'cards')='array' then institution.value->'cards' else '[]'::jsonb end) card(value)
          where coalesce(institution.value->>'name','') || ' • ' || coalesce(card.value->>'name','')=action_row.account_label)) then
    update public.personal_ai_action_proposals set status='stale',acted_at=clock_timestamp() where id=action_row.id;
    return jsonb_build_object('ok',false,'reason','details_changed');
  end if;
  transaction_row := jsonb_build_object('id',transaction_id,'type',action_row.action_type,'subtype',action_row.action_type,'amountCents',action_row.amount_cents,
    'category',action_row.category,'account',action_row.account_label,'description',action_row.description,
    'date',action_row.transaction_date::text || 'T12:00:00.000Z','createdAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  new_version := current_version+1;
  update public.user_financial_state set state=jsonb_set(financial_state,'{transactions}',(case when jsonb_typeof(financial_state->'transactions')='array' then financial_state->'transactions' else '[]'::jsonb end) || jsonb_build_array(transaction_row),true),version=new_version where workspace_id=p_workspace_id;
  update public.personal_ai_action_proposals set status='approved',acted_at=clock_timestamp(),executed_transaction_id=transaction_id where id=action_row.id;
  return jsonb_build_object('ok',true,'version',new_version,'transaction',transaction_row);
end;
$$;
revoke all on function public.confirm_workspace_ai_transaction(uuid,uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.confirm_workspace_ai_transaction(uuid,uuid,uuid,text) to service_role;

commit;
