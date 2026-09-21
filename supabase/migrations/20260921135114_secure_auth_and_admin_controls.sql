-- VALURISE: account lifecycle, master controls and hardened data isolation.
-- This migration intentionally keeps all financial data private to its owner.
-- A master can administrate account lifecycle but does not receive financial-data RLS access.

do $$ begin
  create type public.account_status as enum ('pending', 'active', 'disabled', 'trashed');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.account_role as enum ('user', 'master');
exception when duplicate_object then null;
end $$;

alter table public.profiles
  add column if not exists username text,
  add column if not exists account_status public.account_status not null default 'pending',
  add column if not exists account_role public.account_role not null default 'user',
  add column if not exists avatar_path text,
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists disabled_at timestamptz,
  add column if not exists trashed_at timestamptz;

create unique index if not exists profiles_username_unique_idx
  on public.profiles (lower(username)) where username is not null;
create index if not exists profiles_account_status_idx
  on public.profiles (account_status, created_at desc);

-- This is deliberately a SECURITY DEFINER helper. Its executable privilege is
-- restricted below, and authorization is derived from database-owned profile data,
-- never from editable JWT user_metadata.
create or replace function public.current_user_is_active()
returns boolean
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and account_status = 'active'
  );
$$;

create or replace function public.current_user_is_master()
returns boolean
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid()
      and account_status = 'active'
      and account_role = 'master'
  );
$$;

create or replace function public.handle_valurise_user_created()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  insert into public.profiles (id, full_name, username, account_status, account_role)
  values (
    new.id,
    nullif(trim(coalesce(new.raw_user_meta_data ->> 'full_name', '')), ''),
    nullif(lower(trim(coalesce(new.raw_user_meta_data ->> 'username', ''))), ''),
    'pending',
    'user'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_valurise on auth.users;
create trigger on_auth_user_created_valurise
  after insert on auth.users
  for each row execute procedure public.handle_valurise_user_created();

create or replace function public.set_valurise_profile_updated_at()
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

drop trigger if exists profiles_updated_at_valurise on public.profiles;
create trigger profiles_updated_at_valurise
  before update on public.profiles
  for each row execute procedure public.set_valurise_profile_updated_at();

-- Run only from the protected server using the Supabase secret key. This allows
-- the first master to be bootstrapped without trusting any browser value.
create or replace function public.promote_valurise_master(p_email text)
returns uuid
language plpgsql
security definer
set search_path = public, auth, pg_catalog
as $$
declare target_id uuid;
begin
  select id into target_id from auth.users where lower(email) = lower(trim(p_email));
  if target_id is null then raise exception 'master email not found'; end if;
  update public.profiles
  set account_role = 'master', account_status = 'active', disabled_at = null, trashed_at = null
  where id = target_id;
  return target_id;
end;
$$;

create table if not exists public.master_audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid not null references auth.users(id) on delete cascade,
  target_user_id uuid references auth.users(id) on delete set null,
  action text not null check (action in ('approved', 'rejected', 'disabled', 'restored', 'trashed', 'permanently_deleted')),
  created_at timestamptz not null default now()
);
create index if not exists master_audit_log_actor_created_idx
  on public.master_audit_log(actor_id, created_at desc);

create table if not exists public.user_consents (
  user_id uuid primary key references auth.users(id) on delete cascade,
  privacy_accepted_at timestamptz,
  terms_accepted_at timestamptz,
  cookie_preference text not null default 'unset'
    check (cookie_preference in ('unset', 'essential_only', 'accepted')),
  updated_at timestamptz not null default now()
);

alter table public.master_audit_log enable row level security;
alter table public.user_consents enable row level security;

-- Profiles are intentionally column-restricted. A signed-in user can only edit
-- their own display name/avatar, never their status or role.
revoke all on public.profiles from authenticated;
grant select on public.profiles to authenticated;
grant update(full_name, avatar_path) on public.profiles to authenticated;
grant select, insert, update on public.user_consents to authenticated;
grant select on public.master_audit_log to authenticated;

drop policy if exists "profile owner" on public.profiles;
drop policy if exists "profiles self or master select" on public.profiles;
drop policy if exists "profiles self update" on public.profiles;
create policy "profiles self or master select" on public.profiles for select to authenticated
  using (id = (select auth.uid()) or (select public.current_user_is_master()));
create policy "profiles self update" on public.profiles for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

create policy "users manage own consent" on public.user_consents for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
create policy "masters read their audit log" on public.master_audit_log for select to authenticated
  using (actor_id = (select auth.uid()) and (select public.current_user_is_master()));

-- Existing private tables: all financial actions require an active profile and ownership.
drop policy if exists "accounts owner" on public.accounts;
create policy "active owners manage accounts" on public.accounts for all to authenticated
  using (user_id = (select auth.uid()) and (select public.current_user_is_active()))
  with check (user_id = (select auth.uid()) and (select public.current_user_is_active()));

drop policy if exists "categories owner" on public.categories;
create policy "active owners manage categories" on public.categories for all to authenticated
  using (user_id = (select auth.uid()) and (select public.current_user_is_active()))
  with check (user_id = (select auth.uid()) and (select public.current_user_is_active()));

drop policy if exists "transactions owner" on public.transactions;
create policy "active owners manage transactions" on public.transactions for all to authenticated
  using (user_id = (select auth.uid()) and (select public.current_user_is_active()))
  with check (user_id = (select auth.uid()) and (select public.current_user_is_active()));

drop policy if exists "budgets owner" on public.budgets;
create policy "active owners manage budgets" on public.budgets for all to authenticated
  using (user_id = (select auth.uid()) and (select public.current_user_is_active()))
  with check (user_id = (select auth.uid()) and (select public.current_user_is_active()));

drop policy if exists "goals owner" on public.goals;
create policy "active owners manage goals" on public.goals for all to authenticated
  using (user_id = (select auth.uid()) and (select public.current_user_is_active()))
  with check (user_id = (select auth.uid()) and (select public.current_user_is_active()));

drop policy if exists "users manage own financial state" on public.user_financial_state;
create policy "active users manage own financial state" on public.user_financial_state for all to authenticated
  using (user_id = (select auth.uid()) and (select public.current_user_is_active()))
  with check (user_id = (select auth.uid()) and (select public.current_user_is_active()));

-- Shared goals remain a narrow exception: access is granted only to accepted members.
drop policy if exists "shared goal members can read goals" on public.shared_goals;
drop policy if exists "users create own shared goals" on public.shared_goals;
drop policy if exists "only owner updates shared goals" on public.shared_goals;
drop policy if exists "only owner deletes shared goals" on public.shared_goals;
create policy "active members read shared goals" on public.shared_goals for select to authenticated
  using ((select public.current_user_is_active()) and exists (select 1 from public.shared_goal_members m where m.shared_goal_id = id and m.user_id = (select auth.uid())));
create policy "active users create shared goals" on public.shared_goals for insert to authenticated
  with check ((select public.current_user_is_active()) and owner_id = (select auth.uid()));
create policy "active owners update shared goals" on public.shared_goals for update to authenticated
  using ((select public.current_user_is_active()) and owner_id = (select auth.uid()))
  with check ((select public.current_user_is_active()) and owner_id = (select auth.uid()));
create policy "active owners delete shared goals" on public.shared_goals for delete to authenticated
  using ((select public.current_user_is_active()) and owner_id = (select auth.uid()));

drop policy if exists "members can read member list" on public.shared_goal_members;
drop policy if exists "members can leave shared goals" on public.shared_goal_members;
create policy "active members read member list" on public.shared_goal_members for select to authenticated
  using ((select public.current_user_is_active()) and exists (select 1 from public.shared_goal_members mine where mine.shared_goal_id = shared_goal_id and mine.user_id = (select auth.uid())));
create policy "active members leave shared goals" on public.shared_goal_members for delete to authenticated
  using ((select public.current_user_is_active()) and user_id = (select auth.uid()) and role = 'member');

drop policy if exists "participants can read invitations" on public.shared_goal_invites;
drop policy if exists "recipient can respond to invitation" on public.shared_goal_invites;
create policy "active participants read invitations" on public.shared_goal_invites for select to authenticated
  using ((select public.current_user_is_active()) and (inviter_id = (select auth.uid()) or recipient_id = (select auth.uid())));
create policy "active recipients respond to invitations" on public.shared_goal_invites for update to authenticated
  using ((select public.current_user_is_active()) and recipient_id = (select auth.uid()) and status = 'pending')
  with check ((select public.current_user_is_active()) and recipient_id = (select auth.uid()) and status in ('accepted', 'declined'));

drop policy if exists "members can read contributions" on public.shared_goal_contributions;
drop policy if exists "member adds own contribution" on public.shared_goal_contributions;
drop policy if exists "member removes own contribution" on public.shared_goal_contributions;
create policy "active members read contributions" on public.shared_goal_contributions for select to authenticated
  using ((select public.current_user_is_active()) and exists (select 1 from public.shared_goal_members m where m.shared_goal_id = shared_goal_id and m.user_id = (select auth.uid())));
create policy "active members add own contribution" on public.shared_goal_contributions for insert to authenticated
  with check ((select public.current_user_is_active()) and user_id = (select auth.uid()) and exists (select 1 from public.shared_goal_members m where m.shared_goal_id = shared_goal_id and m.user_id = (select auth.uid())));
create policy "active members remove own contribution" on public.shared_goal_contributions for delete to authenticated
  using ((select public.current_user_is_active()) and user_id = (select auth.uid()));

-- Harden privileged functions. No browser role can promote users or alter roles.
revoke all on function public.current_user_is_active() from public;
revoke all on function public.current_user_is_master() from public;
revoke all on function public.handle_valurise_user_created() from public;
revoke all on function public.set_valurise_profile_updated_at() from public;
revoke all on function public.promote_valurise_master(text) from public;
grant execute on function public.current_user_is_active(), public.current_user_is_master() to authenticated;
grant execute on function public.promote_valurise_master(text) to service_role;

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
  if auth.uid() is null or not public.current_user_is_active() then
    raise exception 'active authentication required';
  end if;
  if not exists (select 1 from public.shared_goals where id = p_goal_id and owner_id = auth.uid()) then
    raise exception 'only the goal owner can invite members';
  end if;
  select id into recipient from public.profiles
    where upper(public_id) = upper(trim(p_recipient_public_id))
      and account_status = 'active';
  if recipient is null then raise exception 'active Valurise ID not found'; end if;
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
  if auth.uid() is null or not public.current_user_is_active() then
    raise exception 'active authentication required';
  end if;
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
grant execute on function public.invite_to_shared_goal(uuid, text), public.respond_shared_goal_invite(uuid, boolean) to authenticated;
