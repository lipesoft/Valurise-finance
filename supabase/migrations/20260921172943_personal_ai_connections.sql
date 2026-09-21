-- VALURISE: optional bring-your-own-key personal AI connections.
-- Keys are encrypted by the application server before insertion. RLS stays on
-- as a defensive default and no browser role receives table privileges.

create table if not exists public.personal_ai_connections (
  user_id uuid primary key references auth.users(id) on delete cascade,
  provider text not null check (provider in ('openai', 'gemini')),
  encrypted_api_key text not null,
  model text not null,
  insights_enabled boolean not null default true,
  notifications_enabled boolean not null default false,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.personal_ai_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null check (char_length(content) between 1 and 4000),
  created_at timestamptz not null default now()
);

create index if not exists personal_ai_messages_user_created_idx
  on public.personal_ai_messages (user_id, created_at desc);

alter table public.personal_ai_connections enable row level security;
alter table public.personal_ai_messages enable row level security;

-- No direct browser access to a connection (even metadata) or encrypted key.
revoke all on public.personal_ai_connections from anon, authenticated;

-- Conversation history is readable only by its owner. Writes are server-side
-- using the secret key after the route independently validates the session.
grant select on public.personal_ai_messages to authenticated;
create policy "users read own personal ai messages"
  on public.personal_ai_messages for select to authenticated
  using (user_id = (select auth.uid()) and (select public.current_user_is_active()));
