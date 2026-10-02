begin;

-- Replace the free-only execution constraint with an explicit administrator allowlist.
alter table public.val_ai_providers drop constraint if exists val_ai_providers_id_check;
alter table public.val_ai_providers add constraint val_ai_providers_id_check
  check (id in ('deepseek','groq','openrouter'));

alter table public.val_ai_models drop constraint if exists val_ai_model_paid_cannot_be_enabled;
alter table public.val_ai_models add constraint val_ai_model_enabled_must_support_chat
  check (not is_enabled or supports_chat);
alter table public.val_ai_models
  add column if not exists input_cost_per_million numeric(14,6) check (input_cost_per_million is null or input_cost_per_million >= 0),
  add column if not exists output_cost_per_million numeric(14,6) check (output_cost_per_million is null or output_cost_per_million >= 0),
  add column if not exists pricing_source text,
  add column if not exists price_verified_at timestamptz;

alter table public.val_ai_runtime_settings
  add column if not exists val_deepseek_enabled boolean not null default true,
  add column if not exists val_fallback_enabled boolean not null default false,
  add column if not exists monthly_cost_soft_limit_usd numeric(14,6) not null default 8 check (monthly_cost_soft_limit_usd >= 0),
  add column if not exists monthly_cost_hard_limit_usd numeric(14,6) not null default 10 check (monthly_cost_hard_limit_usd >= 0),
  add column if not exists reference_balance_usd numeric(14,6) check (reference_balance_usd is null or reference_balance_usd >= 0),
  add column if not exists cost_alert_thresholds integer[] not null default array[50,75,90,95,100];

alter table public.val_ai_user_quota_usage
  add column if not exists reserved_requests integer not null default 0 check (reserved_requests >= 0);
alter table public.val_ai_usage_events
  add column if not exists estimated_cost_usd numeric(14,8) check (estimated_cost_usd is null or estimated_cost_usd >= 0);
alter table public.val_ai_usage_rollups
  add column if not exists estimated_cost_usd numeric(14,8) not null default 0 check (estimated_cost_usd >= 0);

create table if not exists public.val_ai_cost_reservations (
  request_id uuid primary key,
  estimated_cost_usd numeric(14,8) not null check (estimated_cost_usd >= 0),
  expires_at timestamptz not null,
  released_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.val_ai_cost_reservations enable row level security;
revoke all on public.val_ai_cost_reservations from public, anon, authenticated;
grant all on public.val_ai_cost_reservations to service_role;

create table if not exists public.val_ai_admin_test_events (
  request_id uuid primary key,
  actor_id uuid not null references auth.users(id) on delete restrict,
  provider_id text not null references public.val_ai_providers(id),
  model_id text not null,
  status text not null check (status in ('SUCCESS','FAILED')),
  input_tokens integer check (input_tokens is null or input_tokens >= 0),
  output_tokens integer check (output_tokens is null or output_tokens >= 0),
  estimated_cost_usd numeric(14,8) not null default 0 check (estimated_cost_usd >= 0),
  latency_ms integer not null check (latency_ms between 0 and 120000),
  error_category text,
  created_at timestamptz not null default now()
);
create index if not exists val_ai_admin_test_events_created_idx on public.val_ai_admin_test_events(created_at desc);
alter table public.val_ai_admin_test_events enable row level security;
revoke all on public.val_ai_admin_test_events from public, anon, authenticated;
grant all on public.val_ai_admin_test_events to service_role;

-- Keep historical providers/usage, but ensure only the explicitly selected provider can route.
update public.val_ai_providers set enabled = false, health_status = 'DISABLED', updated_at = now()
  where id in ('groq','openrouter');
insert into public.val_ai_providers(id, enabled, health_status, priority)
  values ('deepseek', false, 'DISABLED', 1)
  on conflict (id) do nothing;
update public.val_ai_runtime_settings set
  val_deepseek_enabled = true,
  val_groq_enabled = false,
  val_openrouter_enabled = false,
  val_fallback_enabled = false,
  monthly_cost_soft_limit_usd = 8,
  monthly_cost_hard_limit_usd = 10,
  updated_at = now()
  where id = 1;

-- DeepSeek's current official model and peak (conservative) input/output rates.
-- The administrator may revise these central values after checking the official price page.
insert into public.val_ai_models(
  provider_id, model_id, display_name, is_free, free_verified, is_enabled, priority,
  supports_chat, supports_tools, supports_structured_output, supports_reasoning, supports_streaming,
  context_window, health_status, input_cost_per_million, output_cost_per_million,
  pricing_source, price_verified_at
) values (
  'deepseek', 'deepseek-flash', 'DeepSeek V4.1 Flash', false, false, false, 1,
  true, true, true, true, true,
  1048576, 'DISABLED', 0.300000, 1.200000,
  'Documentação oficial DeepSeek · preço de pico por 1M tokens (verificado em 2026-10-02)', now()
) on conflict (provider_id, model_id) do update set
  display_name = excluded.display_name,
  input_cost_per_million = coalesce(public.val_ai_models.input_cost_per_million, excluded.input_cost_per_million),
  output_cost_per_million = coalesce(public.val_ai_models.output_cost_per_million, excluded.output_cost_per_million),
  pricing_source = coalesce(public.val_ai_models.pricing_source, excluded.pricing_source),
  price_verified_at = coalesce(public.val_ai_models.price_verified_at, excluded.price_verified_at),
  updated_at = now();

-- The prior reservation counter incorrectly charged failed provider attempts.
-- Rebuild the user counters from valid successful answers before changing behavior.
update public.val_ai_user_quota_usage usage set requests = coalesce((
  select count(distinct event.request_id)::integer
  from public.val_ai_usage_events event
  where event.user_id = usage.user_id and event.status = 'SUCCESS'
    and case when usage.period_kind = 'day'
      then (event.created_at at time zone 'America/Sao_Paulo')::date = usage.period_start
      else date_trunc('month', event.created_at at time zone 'America/Sao_Paulo')::date = usage.period_start
    end
), 0);

create unique index if not exists val_ai_one_success_per_request_idx
  on public.val_ai_usage_events(request_id) where status = 'SUCCESS';

create or replace function public.reserve_val_ai_user_request(p_user_id uuid,p_request_id uuid,p_reserved_tokens bigint)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  settings_row public.val_ai_runtime_settings%rowtype;
  override_row public.val_ai_user_quota_overrides%rowtype;
  today_local date := (clock_timestamp() at time zone 'America/Sao_Paulo')::date;
  month_local date := date_trunc('month', clock_timestamp() at time zone 'America/Sao_Paulo')::date;
  day_requests integer; month_requests integer; day_tokens bigint; month_tokens bigint;
  day_reserved integer; month_reserved integer;
  day_limit integer; month_limit integer; day_token_limit bigint; month_token_limit bigint;
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
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text || 'day' || today_local::text, 0));
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text || 'month' || month_local::text, 0));
  if exists (select 1 from public.val_ai_quota_reservations where request_id=p_request_id and user_id=p_user_id) then
    return jsonb_build_object('allowed',false,'reason','DUPLICATE_REQUEST');
  end if;
  for expired_reservation in select * from public.val_ai_quota_reservations
    where user_id=p_user_id and released_at is null and expires_at <= clock_timestamp() for update
  loop
    update public.val_ai_user_quota_usage set
      reserved_tokens=greatest(0,reserved_tokens-expired_reservation.reserved_tokens),
      reserved_requests=greatest(0,reserved_requests-1), updated_at=clock_timestamp()
      where user_id=p_user_id and ((period_kind='day' and period_start=expired_reservation.day_start) or (period_kind='month' and period_start=expired_reservation.month_start));
    update public.val_ai_quota_reservations set released_at=clock_timestamp() where request_id=expired_reservation.request_id;
  end loop;
  select coalesce(requests,0), coalesce(reserved_requests,0), coalesce(tokens,0)+coalesce(reserved_tokens,0)
    into day_requests,day_reserved,day_tokens from public.val_ai_user_quota_usage
    where user_id=p_user_id and period_kind='day' and period_start=today_local;
  select coalesce(requests,0), coalesce(reserved_requests,0), coalesce(tokens,0)+coalesce(reserved_tokens,0)
    into month_requests,month_reserved,month_tokens from public.val_ai_user_quota_usage
    where user_id=p_user_id and period_kind='month' and period_start=month_local;
  day_requests := coalesce(day_requests,0); month_requests := coalesce(month_requests,0);
  day_reserved := coalesce(day_reserved,0); month_reserved := coalesce(month_reserved,0);
  day_tokens := coalesce(day_tokens,0); month_tokens := coalesce(month_tokens,0);
  if day_requests + day_reserved >= day_limit then
    return jsonb_build_object('allowed',false,'reason','DAILY_REQUEST_LIMIT','daily_remaining',greatest(0,day_limit-day_requests-day_reserved),'monthly_remaining',greatest(0,month_limit-month_requests-month_reserved));
  end if;
  if month_requests + month_reserved >= month_limit then
    return jsonb_build_object('allowed',false,'reason','MONTHLY_REQUEST_LIMIT','daily_remaining',greatest(0,day_limit-day_requests-day_reserved),'monthly_remaining',greatest(0,month_limit-month_requests-month_reserved));
  end if;
  if day_tokens + greatest(0,p_reserved_tokens) > day_token_limit or month_tokens + greatest(0,p_reserved_tokens) > month_token_limit then
    return jsonb_build_object('allowed',false,'reason','TOKEN_LIMIT','daily_remaining',greatest(0,day_limit-day_requests-day_reserved),'monthly_remaining',greatest(0,month_limit-month_requests-month_reserved));
  end if;
  insert into public.val_ai_user_quota_usage(user_id,period_kind,period_start,reserved_requests,reserved_tokens,updated_at)
    values (p_user_id,'day',today_local,1,greatest(0,p_reserved_tokens),clock_timestamp())
    on conflict(user_id,period_kind,period_start) do update set reserved_requests=public.val_ai_user_quota_usage.reserved_requests+1,reserved_tokens=public.val_ai_user_quota_usage.reserved_tokens+excluded.reserved_tokens,updated_at=clock_timestamp();
  insert into public.val_ai_user_quota_usage(user_id,period_kind,period_start,reserved_requests,reserved_tokens,updated_at)
    values (p_user_id,'month',month_local,1,greatest(0,p_reserved_tokens),clock_timestamp())
    on conflict(user_id,period_kind,period_start) do update set reserved_requests=public.val_ai_user_quota_usage.reserved_requests+1,reserved_tokens=public.val_ai_user_quota_usage.reserved_tokens+excluded.reserved_tokens,updated_at=clock_timestamp();
  insert into public.val_ai_quota_reservations(request_id,user_id,day_start,month_start,reserved_tokens,expires_at)
    values(p_request_id,p_user_id,today_local,month_local,greatest(0,p_reserved_tokens),clock_timestamp()+interval '5 minutes');
  return jsonb_build_object('allowed',true,'daily_remaining',greatest(0,day_limit-day_requests-day_reserved-1),'monthly_remaining',greatest(0,month_limit-month_requests-month_reserved-1),'daily_limit',day_limit,'monthly_limit',month_limit,'daily_period_start',today_local,'monthly_period_start',month_local);
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
  update public.val_ai_user_quota_usage set reserved_requests=greatest(0,reserved_requests-1),reserved_tokens=greatest(0,reserved_tokens-reservation.reserved_tokens),updated_at=clock_timestamp()
    where user_id=p_user_id and ((period_kind='day' and period_start=reservation.day_start) or (period_kind='month' and period_start=reservation.month_start));
  update public.val_ai_quota_reservations set released_at=clock_timestamp() where request_id=p_request_id;
end; $$;
revoke all on function public.finalize_val_ai_user_request(uuid,uuid) from public, anon, authenticated;
grant execute on function public.finalize_val_ai_user_request(uuid,uuid) to service_role;

create or replace function public.reserve_val_ai_global_cost(p_request_id uuid,p_estimated_cost_usd numeric)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  hard_limit numeric(14,6);
  month_local date := date_trunc('month', clock_timestamp() at time zone 'America/Sao_Paulo')::date;
  actual_cost numeric(14,8); reserved_cost numeric(14,8); estimate numeric(14,8) := greatest(0,coalesce(p_estimated_cost_usd,0));
begin
  if auth.role() is distinct from 'service_role' then raise exception 'server authorization required' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('val-ai-global-cost:' || month_local::text, 0));
  select monthly_cost_hard_limit_usd into hard_limit from public.val_ai_runtime_settings where id=1;
  select coalesce(sum(estimated_cost_usd),0) into actual_cost from public.val_ai_usage_rollups where period_kind='month' and period_start=month_local;
  actual_cost := actual_cost + coalesce((select sum(estimated_cost_usd) from public.val_ai_admin_test_events where date_trunc('month',created_at at time zone 'America/Sao_Paulo')::date=month_local),0);
  select coalesce(sum(estimated_cost_usd),0) into reserved_cost from public.val_ai_cost_reservations where released_at is null and expires_at > clock_timestamp();
  if exists (select 1 from public.val_ai_cost_reservations where request_id=p_request_id) then
    return jsonb_build_object('allowed',false,'reason','DUPLICATE_REQUEST');
  end if;
  if hard_limit is not null and actual_cost + reserved_cost + estimate > hard_limit then
    return jsonb_build_object('allowed',false,'reason','GLOBAL_COST_LIMIT','spent_usd',actual_cost,'reserved_usd',reserved_cost,'limit_usd',hard_limit);
  end if;
  insert into public.val_ai_cost_reservations(request_id,estimated_cost_usd,expires_at)
    values(p_request_id,estimate,clock_timestamp()+interval '5 minutes');
  return jsonb_build_object('allowed',true,'spent_usd',actual_cost,'reserved_usd',reserved_cost,'limit_usd',hard_limit);
end; $$;
revoke all on function public.reserve_val_ai_global_cost(uuid,numeric) from public, anon, authenticated;
grant execute on function public.reserve_val_ai_global_cost(uuid,numeric) to service_role;

create or replace function public.finalize_val_ai_global_cost(p_request_id uuid)
returns void language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if auth.role() is distinct from 'service_role' then raise exception 'server authorization required' using errcode = '42501'; end if;
  update public.val_ai_cost_reservations set released_at=clock_timestamp() where request_id=p_request_id and released_at is null;
end; $$;
revoke all on function public.finalize_val_ai_global_cost(uuid) from public, anon, authenticated;
grant execute on function public.finalize_val_ai_global_cost(uuid) to service_role;

create or replace function public.aggregate_val_ai_usage_event()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  d date := (new.created_at at time zone 'America/Sao_Paulo')::date;
  m date := date_trunc('month', new.created_at at time zone 'America/Sao_Paulo')::date;
  is_answer boolean := new.status='SUCCESS';
begin
  perform pg_advisory_xact_lock(hashtextextended(new.user_id::text || 'day' || d::text, 0));
  perform pg_advisory_xact_lock(hashtextextended(new.user_id::text || 'month' || m::text, 0));
  insert into public.val_ai_user_quota_usage(user_id,period_kind,period_start,requests,tokens,updated_at)
    values(new.user_id,'day',d,case when is_answer then 1 else 0 end,coalesce(new.input_tokens,0)+coalesce(new.output_tokens,0),new.created_at)
    on conflict(user_id,period_kind,period_start) do update set requests=public.val_ai_user_quota_usage.requests+excluded.requests,tokens=public.val_ai_user_quota_usage.tokens+excluded.tokens,updated_at=excluded.updated_at;
  insert into public.val_ai_user_quota_usage(user_id,period_kind,period_start,requests,tokens,updated_at)
    values(new.user_id,'month',m,case when is_answer then 1 else 0 end,coalesce(new.input_tokens,0)+coalesce(new.output_tokens,0),new.created_at)
    on conflict(user_id,period_kind,period_start) do update set requests=public.val_ai_user_quota_usage.requests+excluded.requests,tokens=public.val_ai_user_quota_usage.tokens+excluded.tokens,updated_at=excluded.updated_at;
  if new.provider_id is null or new.model_id is null then return new; end if;
  insert into public.val_ai_usage_rollups(period_kind,period_start,provider_id,model_id,user_id,requests,attempts,successes,failures,fallbacks,input_tokens,output_tokens,latency_total_ms,estimated_cost_usd,updated_at)
    values('day',d,new.provider_id,new.model_id,new.user_id,case when new.attempt_index=1 and is_answer then 1 else 0 end,1,case when is_answer then 1 else 0 end,case when new.status='FAILED' then 1 else 0 end,case when new.attempt_index>1 then 1 else 0 end,coalesce(new.input_tokens,0),coalesce(new.output_tokens,0),new.latency_ms,coalesce(new.estimated_cost_usd,0),new.created_at)
    on conflict(period_kind,period_start,provider_id,model_id,user_id) do update set requests=public.val_ai_usage_rollups.requests+excluded.requests,attempts=public.val_ai_usage_rollups.attempts+excluded.attempts,successes=public.val_ai_usage_rollups.successes+excluded.successes,failures=public.val_ai_usage_rollups.failures+excluded.failures,fallbacks=public.val_ai_usage_rollups.fallbacks+excluded.fallbacks,input_tokens=public.val_ai_usage_rollups.input_tokens+excluded.input_tokens,output_tokens=public.val_ai_usage_rollups.output_tokens+excluded.output_tokens,latency_total_ms=public.val_ai_usage_rollups.latency_total_ms+excluded.latency_total_ms,estimated_cost_usd=public.val_ai_usage_rollups.estimated_cost_usd+excluded.estimated_cost_usd,updated_at=excluded.updated_at;
  insert into public.val_ai_usage_rollups(period_kind,period_start,provider_id,model_id,user_id,requests,attempts,successes,failures,fallbacks,input_tokens,output_tokens,latency_total_ms,estimated_cost_usd,updated_at)
    values('month',m,new.provider_id,new.model_id,new.user_id,case when new.attempt_index=1 and is_answer then 1 else 0 end,1,case when is_answer then 1 else 0 end,case when new.status='FAILED' then 1 else 0 end,case when new.attempt_index>1 then 1 else 0 end,coalesce(new.input_tokens,0),coalesce(new.output_tokens,0),new.latency_ms,coalesce(new.estimated_cost_usd,0),new.created_at)
    on conflict(period_kind,period_start,provider_id,model_id,user_id) do update set requests=public.val_ai_usage_rollups.requests+excluded.requests,attempts=public.val_ai_usage_rollups.attempts+excluded.attempts,successes=public.val_ai_usage_rollups.successes+excluded.successes,failures=public.val_ai_usage_rollups.failures+excluded.failures,fallbacks=public.val_ai_usage_rollups.fallbacks+excluded.fallbacks,input_tokens=public.val_ai_usage_rollups.input_tokens+excluded.input_tokens,output_tokens=public.val_ai_usage_rollups.output_tokens+excluded.output_tokens,latency_total_ms=public.val_ai_usage_rollups.latency_total_ms+excluded.latency_total_ms,estimated_cost_usd=public.val_ai_usage_rollups.estimated_cost_usd+excluded.estimated_cost_usd,updated_at=excluded.updated_at;
  return new;
end; $$;
revoke all on function public.aggregate_val_ai_usage_event() from public, anon, authenticated;

-- Half-open circuit probes must honor explicit activation, but no longer require free metadata.
create or replace function public.claim_val_ai_router_probe(p_provider_id text,p_model_id text,p_claim_provider boolean,p_claim_model boolean)
returns boolean language plpgsql security definer set search_path = pg_catalog, public as $$
declare provider_row public.val_ai_providers%rowtype; model_row public.val_ai_models%rowtype; checked_at timestamptz := clock_timestamp();
begin
  if auth.role() is distinct from 'service_role' then raise exception 'server authorization required' using errcode = '42501'; end if;
  if not p_claim_provider and not p_claim_model then return true; end if;
  if p_claim_provider then
    select * into provider_row from public.val_ai_providers where id=p_provider_id for update;
    if not found or not provider_row.enabled or provider_row.health_status <> 'CIRCUIT_OPEN' or provider_row.circuit_open_until is null or provider_row.circuit_open_until > checked_at then return false; end if;
  end if;
  if p_claim_model then
    select * into model_row from public.val_ai_models where provider_id=p_provider_id and model_id=p_model_id for update;
    if not found or not model_row.is_enabled or not model_row.supports_chat or model_row.health_status <> 'CIRCUIT_OPEN' or model_row.circuit_open_until is null or model_row.circuit_open_until > checked_at then return false; end if;
  end if;
  if p_claim_provider then update public.val_ai_providers set health_status='HALF_OPEN',circuit_open_until=checked_at+interval '30 seconds',updated_at=checked_at where id=p_provider_id; end if;
  if p_claim_model then update public.val_ai_models set health_status='HALF_OPEN',circuit_open_until=checked_at+interval '30 seconds',updated_at=checked_at where provider_id=p_provider_id and model_id=p_model_id; end if;
  return true;
end; $$;
revoke all on function public.claim_val_ai_router_probe(text,text,boolean,boolean) from public, anon, authenticated;
grant execute on function public.claim_val_ai_router_probe(text,text,boolean,boolean) to service_role;

commit;
