-- VALURISE: cross-device state document and brand-safe public IDs.
-- The document is intentionally user-scoped. It permits a safe, incremental
-- migration from the existing local application while the normalized tables
-- remain available for future reporting queries.

create or replace function public.valurise_public_id()
returns text
language sql
volatile
as $$
  select 'VAL-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
$$;

update public.profiles
set public_id = regexp_replace(public_id, '^LUME-', 'VAL-')
where public_id like 'LUME-%';

alter table public.profiles
  alter column public_id set default public.valurise_public_id();

create table if not exists public.user_financial_state (
  user_id uuid primary key references auth.users(id) on delete cascade,
  state jsonb not null default '{}'::jsonb,
  version integer not null default 1 check (version > 0),
  updated_at timestamptz not null default now()
);

create or replace function public.set_user_financial_state_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_catalog
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists user_financial_state_updated_at on public.user_financial_state;
create trigger user_financial_state_updated_at
before update on public.user_financial_state
for each row execute function public.set_user_financial_state_updated_at();

alter table public.user_financial_state enable row level security;
revoke all on table public.user_financial_state from anon;
grant select, insert, update on table public.user_financial_state to authenticated;

create policy "users manage own financial state" on public.user_financial_state
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- Keep the error wording and public brand aligned with the application.
create or replace function public.invite_to_shared_goal(p_goal_id uuid, p_recipient_public_id text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  recipient uuid;
  invitation_id uuid;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if not exists (select 1 from public.shared_goals where id = p_goal_id and owner_id = auth.uid()) then
    raise exception 'only the goal owner can invite members';
  end if;
  select id into recipient from public.profiles where upper(public_id) = upper(trim(p_recipient_public_id));
  if recipient is null then raise exception 'valurise id not found'; end if;
  if recipient = auth.uid() then raise exception 'you already own this goal'; end if;
  insert into public.shared_goal_invites(shared_goal_id, inviter_id, recipient_id)
  values (p_goal_id, auth.uid(), recipient)
  on conflict (shared_goal_id, recipient_id) do update set status = 'pending', created_at = now(), responded_at = null
  returning id into invitation_id;
  return invitation_id;
end;
$$;

revoke all on function public.valurise_public_id() from public;
revoke all on function public.set_user_financial_state_updated_at() from public;
revoke all on function public.invite_to_shared_goal(uuid, text) from public;
grant execute on function public.invite_to_shared_goal(uuid, text) to authenticated;
