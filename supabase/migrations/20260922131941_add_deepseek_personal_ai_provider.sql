-- VALURISE: DeepSeek is an optional personal-AI provider, alongside OpenAI
-- and Gemini. Existing encrypted connections remain untouched.
alter table public.personal_ai_connections
  drop constraint if exists personal_ai_connections_provider_check;

alter table public.personal_ai_connections
  add constraint personal_ai_connections_provider_check
  check (provider in ('openai', 'gemini', 'deepseek'));
