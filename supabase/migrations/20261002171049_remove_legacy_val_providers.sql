begin;

-- Permanently remove Groq/OpenRouter data from the Val central catalog and usage records.
update public.val_ai_runtime_settings
set val_groq_enabled = false,
    val_openrouter_enabled = false,
    updated_at = now()
where id = 1;

-- Retire every old per-user provider/key/model setting. Preferences and
-- consent live in their dedicated tables and are intentionally preserved.
update public.personal_ai_connections
set provider = null,
    encrypted_api_key = null,
    model = null,
    validated_at = null,
    validated_model = null,
    updated_at = now()
where provider is not null
   or encrypted_api_key is not null
   or model is not null
   or validated_at is not null
   or validated_model is not null;

delete from public.personal_ai_usage_events
where provider <> 'deepseek';

delete from public.personal_ai_usage_monthly;
insert into public.personal_ai_usage_monthly(
  user_id, workspace_id, month_start, request_count, chat_count,
  input_tokens, output_tokens, updated_at
)
with totals as (
  select workspace_id,
         date_trunc('month', created_at)::date as month_start,
         count(*)::integer as request_count,
         count(*) filter (where kind = 'chat')::integer as chat_count,
         coalesce(sum(input_tokens), 0)::bigint as input_tokens,
         coalesce(sum(output_tokens), 0)::bigint as output_tokens,
         max(created_at) as updated_at
  from public.personal_ai_usage_events
  group by workspace_id, date_trunc('month', created_at)::date
), workspace_actor as (
  select distinct on (workspace_id, date_trunc('month', created_at)::date)
         workspace_id,
         date_trunc('month', created_at)::date as month_start,
         user_id
  from public.personal_ai_usage_events
  order by workspace_id, date_trunc('month', created_at)::date, created_at desc, id desc
)
select actor.user_id, totals.workspace_id, totals.month_start, totals.request_count,
       totals.chat_count, totals.input_tokens, totals.output_tokens, totals.updated_at
from totals
join workspace_actor actor using (workspace_id, month_start);

alter table public.personal_ai_connections
  drop constraint if exists personal_ai_connections_provider_check;
alter table public.personal_ai_connections
  add constraint personal_ai_connections_provider_check
  check (provider is null or provider = 'deepseek');

alter table public.personal_ai_usage_events
  drop constraint if exists personal_ai_usage_events_provider_check;
alter table public.personal_ai_usage_events
  add constraint personal_ai_usage_events_provider_check
  check (provider = 'deepseek');

delete from public.val_ai_usage_events
where provider_id in ('groq', 'openrouter');

delete from public.val_ai_usage_rollups
where provider_id in ('groq', 'openrouter');

delete from public.val_ai_admin_test_events
where provider_id in ('groq', 'openrouter');

delete from public.val_ai_admin_audit_log
where provider_id in ('groq', 'openrouter');

delete from public.val_ai_usage_events
where provider_id in ('groq', 'openrouter');

delete from public.val_ai_provider_keys
where provider_id in ('groq', 'openrouter');

delete from public.val_ai_models
where provider_id in ('groq', 'openrouter');

delete from public.val_ai_providers
where id in ('groq', 'openrouter');

alter table public.val_ai_providers
  drop constraint if exists val_ai_providers_id_check;
alter table public.val_ai_providers
  add constraint val_ai_providers_id_check check (id = 'deepseek');

alter table public.val_ai_models
  drop constraint if exists val_ai_openrouter_free_requires_zero_official_price;

alter table public.val_ai_providers
  drop column if exists free_tier_confirmed;

alter table public.val_ai_runtime_settings
  drop column if exists val_groq_enabled,
  drop column if exists val_openrouter_enabled;

-- Keep per-user limits accurate after deleting provider-specific success history.
update public.val_ai_user_quota_usage as usage
set requests = coalesce((
      select count(distinct event.request_id)::integer
      from public.val_ai_usage_events as event
      where event.user_id = usage.user_id
        and event.provider_id = 'deepseek'
        and event.status = 'SUCCESS'
        and case when usage.period_kind = 'day'
          then (event.created_at at time zone 'America/Sao_Paulo')::date = usage.period_start
          else date_trunc('month', event.created_at at time zone 'America/Sao_Paulo')::date = usage.period_start
        end
    ), 0),
    tokens = coalesce((
      select sum(coalesce(event.input_tokens, 0) + coalesce(event.output_tokens, 0))::bigint
      from public.val_ai_usage_events as event
      where event.user_id = usage.user_id
        and event.provider_id = 'deepseek'
        and event.status = 'SUCCESS'
        and case when usage.period_kind = 'day'
          then (event.created_at at time zone 'America/Sao_Paulo')::date = usage.period_start
          else date_trunc('month', event.created_at at time zone 'America/Sao_Paulo')::date = usage.period_start
        end
    ), 0),
    updated_at = now();

commit;
