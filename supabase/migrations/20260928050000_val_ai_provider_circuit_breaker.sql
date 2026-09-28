begin;

alter table public.val_ai_providers
  add column if not exists failure_count integer not null default 0 check (failure_count >= 0),
  add column if not exists circuit_open_until timestamptz;

create or replace function public.claim_val_ai_router_probe(
  p_provider_id text,
  p_model_id text,
  p_claim_provider boolean,
  p_claim_model boolean
)
returns boolean
language plpgsql security definer set search_path = pg_catalog, public
as $$
declare
  provider_row public.val_ai_providers%rowtype;
  model_row public.val_ai_models%rowtype;
  checked_at timestamptz := clock_timestamp();
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'server authorization required' using errcode = '42501';
  end if;
  if not p_claim_provider and not p_claim_model then return true; end if;

  -- Always lock provider before model; result recording uses the same lock order.
  if p_claim_provider then
    select * into provider_row from public.val_ai_providers where id = p_provider_id for update;
    if not found or not provider_row.enabled or provider_row.health_status <> 'CIRCUIT_OPEN'
      or provider_row.circuit_open_until is null or provider_row.circuit_open_until > checked_at then
      return false;
    end if;
  end if;
  if p_claim_model then
    select * into model_row from public.val_ai_models
      where provider_id = p_provider_id and model_id = p_model_id for update;
    if not found or not model_row.is_enabled or not model_row.is_free or not model_row.free_verified
      or model_row.health_status <> 'CIRCUIT_OPEN'
      or model_row.circuit_open_until is null or model_row.circuit_open_until > checked_at then
      return false;
    end if;
  end if;

  if p_claim_provider then
    update public.val_ai_providers set health_status = 'HALF_OPEN',
      circuit_open_until = checked_at + interval '30 seconds', updated_at = checked_at
      where id = p_provider_id;
  end if;
  if p_claim_model then
    update public.val_ai_models set health_status = 'HALF_OPEN',
      circuit_open_until = checked_at + interval '30 seconds', updated_at = checked_at
      where provider_id = p_provider_id and model_id = p_model_id;
  end if;
  return true;
end;
$$;
revoke all on function public.claim_val_ai_router_probe(text,text,boolean,boolean) from public, anon, authenticated;
grant execute on function public.claim_val_ai_router_probe(text,text,boolean,boolean) to service_role;

create or replace function public.record_val_ai_model_result(
  p_provider_id text, p_model_id text, p_success boolean, p_latency_ms integer,
  p_error_category text default null, p_error_code text default null, p_quota_headers jsonb default '{}'::jsonb
)
returns void language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  threshold smallint;
  cooldown integer;
  provider_failure boolean := coalesce(p_error_category, '') in (
    'RATE_LIMITED','QUOTA_EXCEEDED','PROVIDER_OVERLOADED','PROVIDER_UNAVAILABLE',
    'TIMEOUT','NETWORK_ERROR','UNKNOWN_PROVIDER_ERROR','INVALID_API_KEY',
    'PERMISSION_DENIED','BILLING_REQUIRED','INSUFFICIENT_BALANCE','REGION_RESTRICTED'
  );
  model_failure boolean := coalesce(p_error_category, '') in (
    'RATE_LIMITED','QUOTA_EXCEEDED','PROVIDER_OVERLOADED','PROVIDER_UNAVAILABLE',
    'TIMEOUT','NETWORK_ERROR','UNKNOWN_PROVIDER_ERROR','INVALID_API_KEY',
    'PERMISSION_DENIED','BILLING_REQUIRED','INSUFFICIENT_BALANCE','REGION_RESTRICTED',
    'MODEL_UNAVAILABLE','INVALID_MODEL','TOOL_CALL_UNSUPPORTED','MALFORMED_RESPONSE'
  );
  checked_at timestamptz := clock_timestamp();
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'server authorization required' using errcode = '42501';
  end if;
  select circuit_failure_threshold, circuit_cooldown_seconds into threshold, cooldown
    from public.val_ai_runtime_settings where id = 1;

  -- Provider first, then model: keep lock order consistent with half-open claims.
  update public.val_ai_providers set
    last_health_check = checked_at,
    last_latency_ms = greatest(0, least(120000, p_latency_ms)),
    last_error_category = case when p_success then null else p_error_category end,
    last_error_code = case when p_success then null else p_error_code end,
    quota_headers = coalesce(p_quota_headers, '{}'::jsonb),
    failure_count = case when not enabled then failure_count when p_success or not provider_failure then failure_count else failure_count + 1 end,
    health_status = case
      when not enabled then 'DISABLED'
      when p_success then 'HEALTHY'
      when health_status = 'HALF_OPEN' and not provider_failure then 'DEGRADED'
      when not provider_failure then health_status
      when failure_count + 1 >= coalesce(threshold, 3) then 'CIRCUIT_OPEN'
      else 'DEGRADED'
    end,
    circuit_open_until = case
      when not enabled or p_success or (health_status = 'HALF_OPEN' and not provider_failure) then null
      when provider_failure and failure_count + 1 >= coalesce(threshold, 3)
        then checked_at + make_interval(secs => coalesce(cooldown, 120))
      else circuit_open_until
    end,
    updated_at = checked_at
    where id = p_provider_id;

  update public.val_ai_models set
    last_health_check = checked_at,
    last_latency_ms = greatest(0, least(120000, p_latency_ms)),
    last_error_category = case when p_success then null else p_error_category end,
    last_error_code = case when p_success then null else p_error_code end,
    failure_count = case when not is_enabled then failure_count when p_success or not model_failure then failure_count else failure_count + 1 end,
    health_status = case
      when not is_enabled then 'DISABLED'
      when p_success then 'HEALTHY'
      when health_status = 'HALF_OPEN' and not model_failure then 'DEGRADED'
      when not model_failure then health_status
      when failure_count + 1 >= coalesce(threshold, 3) then 'CIRCUIT_OPEN'
      else 'DEGRADED'
    end,
    circuit_open_until = case
      when not is_enabled or p_success or (health_status = 'HALF_OPEN' and not model_failure) then null
      when model_failure and failure_count + 1 >= coalesce(threshold, 3)
        then checked_at + make_interval(secs => coalesce(cooldown, 120))
      else circuit_open_until
    end,
    last_success_at = case when p_success then checked_at else last_success_at end,
    last_failure_at = case when p_success or not model_failure then last_failure_at else checked_at end,
    updated_at = checked_at
    where provider_id = p_provider_id and model_id = p_model_id;
end;
$$;
revoke all on function public.record_val_ai_model_result(text,text,boolean,integer,text,text,jsonb) from public, anon, authenticated;
grant execute on function public.record_val_ai_model_result(text,text,boolean,integer,text,text,jsonb) to service_role;

commit;
