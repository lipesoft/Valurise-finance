-- Safe aggregate telemetry for user-owned BYOK AI calls. No prompt, response,
-- API key, authentication token, or financial record is stored here.

create table if not exists public.personal_ai_usage_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('openai', 'gemini', 'deepseek')),
  model text not null check (char_length(model) between 2 and 100),
  kind text not null check (kind in ('chat', 'connection_test')),
  input_tokens integer check (input_tokens is null or input_tokens >= 0),
  output_tokens integer check (output_tokens is null or output_tokens >= 0),
  latency_ms integer not null check (latency_ms between 0 and 120000),
  error_category text,
  provider_code text,
  request_id text,
  created_at timestamptz not null default now()
);

create index if not exists personal_ai_usage_events_user_created_idx
  on public.personal_ai_usage_events (user_id, created_at desc);

create table if not exists public.personal_ai_usage_monthly (
  user_id uuid not null references auth.users(id) on delete cascade,
  month_start date not null,
  request_count integer not null default 0 check (request_count >= 0),
  chat_count integer not null default 0 check (chat_count >= 0),
  input_tokens bigint not null default 0 check (input_tokens >= 0),
  output_tokens bigint not null default 0 check (output_tokens >= 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, month_start)
);

alter table public.personal_ai_usage_events enable row level security;
alter table public.personal_ai_usage_monthly enable row level security;

revoke all on table public.personal_ai_usage_events from public, anon, authenticated;
revoke all on table public.personal_ai_usage_monthly from public, anon, authenticated;
grant select on table public.personal_ai_usage_events to authenticated;
grant select on table public.personal_ai_usage_monthly to authenticated;
grant all on table public.personal_ai_usage_events to service_role;
grant all on table public.personal_ai_usage_monthly to service_role;

create policy "active users read own AI usage events"
  on public.personal_ai_usage_events for select to authenticated
  using (user_id = (select auth.uid()) and (select public.current_user_is_active()));
create policy "active users read own AI monthly usage"
  on public.personal_ai_usage_monthly for select to authenticated
  using (user_id = (select auth.uid()) and (select public.current_user_is_active()));

create or replace function public.aggregate_personal_ai_usage()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  insert into public.personal_ai_usage_monthly as monthly (
    user_id, month_start, request_count, chat_count, input_tokens, output_tokens, updated_at
  ) values (
    new.user_id,
    date_trunc('month', new.created_at)::date,
    1,
    case when new.kind = 'chat' then 1 else 0 end,
    coalesce(new.input_tokens, 0),
    coalesce(new.output_tokens, 0),
    new.created_at
  )
  on conflict (user_id, month_start) do update set
    request_count = monthly.request_count + 1,
    chat_count = monthly.chat_count + excluded.chat_count,
    input_tokens = monthly.input_tokens + excluded.input_tokens,
    output_tokens = monthly.output_tokens + excluded.output_tokens,
    updated_at = excluded.updated_at;
  return new;
end;
$$;

revoke all on function public.aggregate_personal_ai_usage() from public, anon, authenticated;
drop trigger if exists personal_ai_usage_events_aggregate on public.personal_ai_usage_events;
create trigger personal_ai_usage_events_aggregate
  after insert on public.personal_ai_usage_events
  for each row execute function public.aggregate_personal_ai_usage();
