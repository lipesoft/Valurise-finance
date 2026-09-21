-- Shared goals: a goal is private by default and only the explicitly invited
-- participants can see its balance, contributions and history.
alter table public.profiles
  add column if not exists public_id text unique;

create or replace function public.lume_public_id()
returns text
language sql
volatile
as $$
  select 'LUME-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
$$;

update public.profiles
set public_id = public.lume_public_id()
where public_id is null;

alter table public.profiles
  alter column public_id set default public.lume_public_id();

alter table public.profiles
  alter column public_id set not null;

create table public.shared_goals (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(trim(name)) between 1 and 100),
  target_cents bigint not null check (target_cents > 0),
  target_date date,
  created_at timestamptz not null default now()
);

create table public.shared_goal_members (
  shared_goal_id uuid not null references public.shared_goals(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'member')),
  joined_at timestamptz not null default now(),
  primary key (shared_goal_id, user_id)
);

create table public.shared_goal_invites (
  id uuid primary key default gen_random_uuid(),
  shared_goal_id uuid not null references public.shared_goals(id) on delete cascade,
  inviter_id uuid not null references auth.users(id) on delete cascade,
  recipient_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined', 'cancelled')),
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  unique (shared_goal_id, recipient_id)
);

create table public.shared_goal_contributions (
  id uuid primary key default gen_random_uuid(),
  shared_goal_id uuid not null references public.shared_goals(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  amount_cents bigint not null check (amount_cents > 0),
  account_id uuid references public.accounts(id) on delete set null,
  note text,
  contributed_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create or replace function public.add_shared_goal_owner()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  insert into public.shared_goal_members(shared_goal_id, user_id, role)
  values (new.id, new.owner_id, 'owner');
  return new;
end;
$$;

create trigger shared_goal_owner_membership
after insert on public.shared_goals
for each row execute function public.add_shared_goal_owner();

create index shared_goal_members_user_idx on public.shared_goal_members(user_id, shared_goal_id);
create index shared_goal_contributions_goal_date_idx on public.shared_goal_contributions(shared_goal_id, contributed_at desc);
create index shared_goal_invites_recipient_idx on public.shared_goal_invites(recipient_id, status);

alter table public.shared_goals enable row level security;
alter table public.shared_goal_members enable row level security;
alter table public.shared_goal_invites enable row level security;
alter table public.shared_goal_contributions enable row level security;

create policy "shared goal members can read goals" on public.shared_goals for select to authenticated
using (exists (select 1 from public.shared_goal_members m where m.shared_goal_id = id and m.user_id = (select auth.uid())));
create policy "users create own shared goals" on public.shared_goals for insert to authenticated
with check ((select auth.uid()) = owner_id);
create policy "only owner updates shared goals" on public.shared_goals for update to authenticated
using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
create policy "only owner deletes shared goals" on public.shared_goals for delete to authenticated
using ((select auth.uid()) = owner_id);

create policy "members can read member list" on public.shared_goal_members for select to authenticated
using (exists (select 1 from public.shared_goal_members mine where mine.shared_goal_id = shared_goal_id and mine.user_id = (select auth.uid())));
create policy "members can leave shared goals" on public.shared_goal_members for delete to authenticated
using (user_id = (select auth.uid()) and role = 'member');

create policy "participants can read invitations" on public.shared_goal_invites for select to authenticated
using (inviter_id = (select auth.uid()) or recipient_id = (select auth.uid()));
create policy "recipient can respond to invitation" on public.shared_goal_invites for update to authenticated
using (recipient_id = (select auth.uid()) and status = 'pending')
with check (recipient_id = (select auth.uid()) and status in ('accepted', 'declined'));

create policy "members can read contributions" on public.shared_goal_contributions for select to authenticated
using (exists (select 1 from public.shared_goal_members m where m.shared_goal_id = shared_goal_id and m.user_id = (select auth.uid())));
create policy "member adds own contribution" on public.shared_goal_contributions for insert to authenticated
with check (user_id = (select auth.uid()) and exists (select 1 from public.shared_goal_members m where m.shared_goal_id = shared_goal_id and m.user_id = (select auth.uid())));
create policy "member removes own contribution" on public.shared_goal_contributions for delete to authenticated
using (user_id = (select auth.uid()));

-- RPC keeps the internal UUID private: the UI only receives a public Lume ID.
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
  if recipient is null then raise exception 'lume id not found'; end if;
  if recipient = auth.uid() then raise exception 'you already own this goal'; end if;
  insert into public.shared_goal_invites(shared_goal_id, inviter_id, recipient_id)
  values (p_goal_id, auth.uid(), recipient)
  on conflict (shared_goal_id, recipient_id) do update set status = 'pending', created_at = now(), responded_at = null
  returning id into invitation_id;
  return invitation_id;
end;
$$;

create or replace function public.respond_shared_goal_invite(p_invite_id uuid, p_accept boolean)
returns void
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare target_goal uuid;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  update public.shared_goal_invites
  set status = case when p_accept then 'accepted' else 'declined' end, responded_at = now()
  where id = p_invite_id and recipient_id = auth.uid() and status = 'pending'
  returning shared_goal_id into target_goal;
  if target_goal is null then raise exception 'invite not available'; end if;
  if p_accept then
    insert into public.shared_goal_members(shared_goal_id, user_id, role)
    values (target_goal, auth.uid(), 'member') on conflict do nothing;
  end if;
end;
$$;

revoke all on function public.invite_to_shared_goal(uuid, text) from public;
revoke all on function public.respond_shared_goal_invite(uuid, boolean) from public;
revoke all on function public.add_shared_goal_owner() from public;
grant execute on function public.invite_to_shared_goal(uuid, text), public.respond_shared_goal_invite(uuid, boolean) to authenticated;

grant select, insert, update, delete on public.shared_goals, public.shared_goal_members, public.shared_goal_invites, public.shared_goal_contributions to authenticated;
