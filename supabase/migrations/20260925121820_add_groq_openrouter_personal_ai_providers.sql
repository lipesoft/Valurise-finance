-- Expand provider validation; keep existing encrypted connections and telemetry rows intact.
alter table public.personal_ai_connections
  drop constraint if exists personal_ai_connections_provider_check;

alter table public.personal_ai_connections
  add constraint personal_ai_connections_provider_check
  check (provider in ('openai', 'gemini', 'deepseek', 'groq', 'openrouter')) not valid;

alter table public.personal_ai_connections
  validate constraint personal_ai_connections_provider_check;

alter table public.personal_ai_usage_events
  drop constraint if exists personal_ai_usage_events_provider_check;

alter table public.personal_ai_usage_events
  add constraint personal_ai_usage_events_provider_check
  check (provider in ('openai', 'gemini', 'deepseek', 'groq', 'openrouter')) not valid;

alter table public.personal_ai_usage_events
  validate constraint personal_ai_usage_events_provider_check;
