-- Valurise multi-workspace foundation.
-- Expand/backfill first; legacy owner UUIDs are retained only as attribution and
-- for old personal-state lookups. Workspace membership is the authorization
-- boundary; active-workspace selection is only a persisted startup preference.
begin;

create schema if not exists valurise_private;
revoke all on schema valurise_private from public, anon;
grant usage on schema valurise_private to authenticated, service_role;

create table if not exists public.workspaces (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('personal', 'business')),
  display_name text not null check (char_length(trim(display_name)) between 1 and 120),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);
create unique index if not exists workspaces_one_personal_per_owner_idx
  on public.workspaces(owner_user_id) where type = 'personal';
create index if not exists workspaces_owner_idx on public.workspaces(owner_user_id);

create table if not exists public.workspace_memberships (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'finance', 'accountant', 'viewer')),
  status text not null default 'active' check (status in ('active', 'invited', 'removed')),
  created_at timestamptz not null default now(),
  unique (workspace_id, user_id)
);
create index if not exists workspace_memberships_user_status_idx
  on public.workspace_memberships(user_id, status, workspace_id);
create index if not exists workspace_memberships_workspace_role_idx
  on public.workspace_memberships(workspace_id, status, role);

-- Account erasure may cascade a workspace owned only by that account. Do not
-- erase a business workspace that already has other active members; ownership
-- transfer must happen first once collaborative membership management exists.
create or replace function valurise_private.reject_workspace_delete_with_members()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public
as $$
begin
  if exists (
    select 1 from public.workspace_memberships membership
    where membership.workspace_id = old.id and membership.user_id <> old.owner_user_id
      and membership.status = 'active'
  ) then
    raise exception 'workspace owner must transfer ownership before deletion' using errcode = '23503';
  end if;
  return old;
end;
$$;
revoke all on function valurise_private.reject_workspace_delete_with_members() from public, anon, authenticated;
drop trigger if exists prevent_workspace_owner_data_loss on public.workspaces;
create trigger prevent_workspace_owner_data_loss before delete on public.workspaces
  for each row execute function valurise_private.reject_workspace_delete_with_members();

create table if not exists public.business_profiles (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  legal_name text not null check (char_length(trim(legal_name)) between 2 and 180),
  trade_name text not null check (char_length(trim(trade_name)) between 2 and 120),
  cnpj text not null check (cnpj ~ '^[0-9]{14}$'),
  email text,
  phone text,
  logo_url text,
  postal_code text,
  street text,
  number text,
  address_complement text,
  neighborhood text,
  city text,
  state text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists business_profiles_cnpj_unique_idx on public.business_profiles(cnpj);

create table if not exists public.user_active_workspaces (
  user_id uuid primary key references auth.users(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  updated_at timestamptz not null default now()
);
create index if not exists user_active_workspaces_workspace_idx
  on public.user_active_workspaces(workspace_id);

create or replace function public.valurise_is_valid_cnpj(p_cnpj text)
returns boolean
language plpgsql immutable strict
set search_path = pg_catalog
as $$
declare
  digits text := regexp_replace(p_cnpj, '[^0-9]', '', 'g');
  total integer := 0;
  remainder integer;
  first_digit integer;
  second_digit integer;
  weight integer;
  position integer;
begin
  if length(digits) <> 14 or digits !~ '^[0-9]{14}$'
     or digits = repeat(substr(digits, 1, 1), 14) then
    return false;
  end if;
  for position in 1..12 loop
    weight := case when position <= 4 then 6 - position else 14 - position end;
    total := total + substr(digits, position, 1)::integer * weight;
  end loop;
  remainder := total % 11;
  first_digit := case when remainder < 2 then 0 else 11 - remainder end;
  if first_digit <> substr(digits, 13, 1)::integer then return false; end if;
  total := 0;
  for position in 1..13 loop
    weight := case when position <= 5 then 7 - position else 15 - position end;
    total := total + substr(digits, position, 1)::integer * weight;
  end loop;
  remainder := total % 11;
  second_digit := case when remainder < 2 then 0 else 11 - remainder end;
  return second_digit = substr(digits, 14, 1)::integer;
end;
$$;
revoke all on function public.valurise_is_valid_cnpj(text) from public, anon, authenticated;
alter table public.business_profiles drop constraint if exists business_profiles_cnpj_valid;
alter table public.business_profiles add constraint business_profiles_cnpj_valid
  check (public.valurise_is_valid_cnpj(cnpj));

-- Create the default personal context for current active accounts. This is
-- intentionally independent of financial values and is safe to rerun.
insert into public.workspaces(type, display_name, owner_user_id)
select 'personal', coalesce(nullif(trim(profile.full_name), ''), 'Pessoal'), profile.id
from public.profiles profile
where profile.account_status = 'active'
  and not exists (
    select 1 from public.workspaces workspace
    where workspace.type = 'personal' and workspace.owner_user_id = profile.id
  )
on conflict do nothing;

insert into public.workspace_memberships(workspace_id, user_id, role, status)
select workspace.id, workspace.owner_user_id, 'owner', 'active'
from public.workspaces workspace
where workspace.type = 'personal'
on conflict (workspace_id, user_id) do nothing;

-- A profile becomes active only after Master approval. Provisioning here means
-- approved new accounts receive a personal workspace without a race in the UI.
create or replace function public.provision_personal_workspace_for_active_profile()
returns trigger
language plpgsql security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare
  personal_id uuid;
begin
  if new.account_status <> 'active' or new.account_role not in ('user', 'master') then
    return new;
  end if;
  insert into public.workspaces(type, display_name, owner_user_id)
  values ('personal', coalesce(nullif(trim(new.full_name), ''), 'Pessoal'), new.id)
  on conflict (owner_user_id) where type = 'personal' do update
    set display_name = case when public.workspaces.display_name = 'Pessoal'
      then excluded.display_name else public.workspaces.display_name end
  returning id into personal_id;
  insert into public.workspace_memberships(workspace_id, user_id, role, status)
  values (personal_id, new.id, 'owner', 'active')
  on conflict (workspace_id, user_id) do update set status = 'active';
  insert into public.user_active_workspaces(user_id, workspace_id)
  values (new.id, personal_id)
  on conflict (user_id) do nothing;
  return new;
end;
$$;
revoke all on function public.provision_personal_workspace_for_active_profile() from public, anon, authenticated;
drop trigger if exists provision_personal_workspace_after_profile_activation on public.profiles;
create trigger provision_personal_workspace_after_profile_activation
after insert or update of account_status, account_role on public.profiles
for each row execute function public.provision_personal_workspace_for_active_profile();

-- Backfill any legacy financial owner that predates a profile row or trigger.
insert into public.workspaces(type, display_name, owner_user_id)
select 'personal', 'Pessoal', owners.user_id
from (
  select user_id from public.user_financial_state
  union select user_id from public.accounts
  union select user_id from public.categories
  union select user_id from public.transactions
  union select user_id from public.budgets
  union select user_id from public.goals
  union select user_id from public.financial_institutions
  union select user_id from public.credit_cards
  union select user_id from public.personal_ai_connections
  union select user_id from public.personal_ai_messages
  union select user_id from public.personal_ai_usage_events
  union select user_id from public.personal_ai_usage_monthly
  union select user_id from public.personal_ai_action_proposals
) owners
where owners.user_id is not null
  and not exists (
  select 1 from public.workspaces workspace
  where workspace.type = 'personal' and workspace.owner_user_id = owners.user_id
)
on conflict do nothing;
insert into public.workspace_memberships(workspace_id, user_id, role, status)
select workspace.id, workspace.owner_user_id, 'owner', 'active'
from public.workspaces workspace
where workspace.type = 'personal'
on conflict (workspace_id, user_id) do nothing;
insert into public.user_active_workspaces(user_id, workspace_id)
select membership.user_id, membership.workspace_id
from public.workspace_memberships membership
join public.workspaces workspace on workspace.id = membership.workspace_id and workspace.type = 'personal'
on conflict (user_id) do nothing;

-- The JSON document remains the compatibility store. Its new primary identity
-- is workspace_id; user_id is nullable and retained for the personal workspace
-- so older clients can still see only that one document during rollout.
alter table public.user_financial_state add column if not exists workspace_id uuid;
update public.user_financial_state financial
set workspace_id = workspace.id
from public.workspaces workspace
where workspace.type = 'personal'
  and workspace.owner_user_id = financial.user_id
  and financial.workspace_id is null;
do $$ begin
  if exists (select 1 from public.user_financial_state where workspace_id is null) then
    raise exception 'Workspace backfill incomplete for user_financial_state';
  end if;
end $$;
alter table public.user_financial_state alter column workspace_id set not null;
alter table public.user_financial_state drop constraint if exists user_financial_state_pkey;
alter table public.user_financial_state alter column user_id drop not null;
alter table public.user_financial_state
  add constraint user_financial_state_pkey primary key (workspace_id);
alter table public.user_financial_state drop constraint if exists user_financial_state_workspace_id_fkey;
alter table public.user_financial_state
  add constraint user_financial_state_workspace_id_fkey foreign key (workspace_id)
  references public.workspaces(id) on delete cascade;
-- Keep the legacy user_id conflict target available during a rolling deploy.
-- PostgreSQL UNIQUE permits multiple NULLs, so business workspaces remain valid.
create unique index if not exists user_financial_state_legacy_user_unique_idx
  on public.user_financial_state(user_id);
create index if not exists user_financial_state_workspace_updated_idx
  on public.user_financial_state(workspace_id, updated_at desc);

-- Normalized finance tables keep their legacy user_id attribution while each
-- row is assigned a workspace. Composite scoping supports future CRUD safely.
do $$
declare table_name text;
  null_count bigint;
begin
  foreach table_name in array array[
    'accounts', 'categories', 'transactions', 'budgets', 'goals',
    'financial_institutions', 'credit_cards'
  ] loop
    execute format('alter table public.%I add column if not exists workspace_id uuid', table_name);
    execute format(
      'update public.%I row_data set workspace_id = workspace.id from public.workspaces workspace where row_data.workspace_id is null and workspace.type = ''personal'' and workspace.owner_user_id = row_data.user_id',
      table_name
    );
    execute format('select count(*) from public.%I where workspace_id is null', table_name) into null_count;
    if null_count > 0 then raise exception 'Workspace backfill incomplete for %', table_name; end if;
    execute format('alter table public.%I alter column workspace_id set not null', table_name);
    execute format('alter table public.%I drop constraint if exists %I', table_name, table_name || '_workspace_id_fkey');
    execute format(
      'alter table public.%I add constraint %I foreign key (workspace_id) references public.workspaces(id) on delete cascade',
      table_name, table_name || '_workspace_id_fkey'
    );
    execute format('create index if not exists %I on public.%I(workspace_id)', table_name || '_workspace_idx', table_name);
    execute format('create unique index if not exists %I on public.%I(workspace_id, id)', table_name || '_workspace_id_id_uidx', table_name);
  end loop;
end $$;

-- Natural uniqueness is workspace-scoped, not tied to whichever member first
-- created a record. Existing empty/legacy rows are preserved.
alter table public.categories drop constraint if exists categories_user_id_name_kind_key;
create unique index if not exists categories_workspace_name_kind_uidx
  on public.categories(workspace_id, name, kind);
alter table public.budgets drop constraint if exists budgets_user_id_category_id_month_key;
create unique index if not exists budgets_workspace_category_month_uidx
  on public.budgets(workspace_id, category_id, month);
alter table public.financial_institutions drop constraint if exists financial_institutions_user_id_name_key;
create unique index if not exists financial_institutions_workspace_name_uidx
  on public.financial_institutions(workspace_id, name);
create index if not exists transactions_workspace_date_idx
  on public.transactions(workspace_id, occurred_at desc);
create index if not exists budgets_workspace_month_idx
  on public.budgets(workspace_id, month desc);
create index if not exists accounts_workspace_active_idx
  on public.accounts(workspace_id, is_active);
create index if not exists goals_workspace_created_idx
  on public.goals(workspace_id, created_at desc);
create index if not exists credit_cards_workspace_institution_idx
  on public.credit_cards(workspace_id, institution_id);

-- Prevent a row in one workspace from pointing at another workspace's account,
-- category or institution through otherwise globally valid UUID foreign keys.
alter table public.accounts drop constraint if exists accounts_institution_id_fkey;
alter table public.accounts drop constraint if exists accounts_workspace_institution_fkey;
alter table public.accounts add constraint accounts_workspace_institution_fkey
  foreign key (workspace_id, institution_id)
  references public.financial_institutions(workspace_id, id)
  on delete set null (institution_id);
alter table public.credit_cards drop constraint if exists credit_cards_institution_id_fkey;
alter table public.credit_cards drop constraint if exists credit_cards_workspace_institution_fkey;
alter table public.credit_cards add constraint credit_cards_workspace_institution_fkey
  foreign key (workspace_id, institution_id)
  references public.financial_institutions(workspace_id, id)
  on delete cascade;
alter table public.transactions drop constraint if exists transactions_category_id_fkey;
alter table public.transactions drop constraint if exists transactions_workspace_category_fkey;
alter table public.transactions add constraint transactions_workspace_category_fkey
  foreign key (workspace_id, category_id)
  references public.categories(workspace_id, id)
  on delete set null (category_id);
alter table public.transactions drop constraint if exists transactions_account_id_fkey;
alter table public.transactions drop constraint if exists transactions_workspace_account_fkey;
alter table public.transactions add constraint transactions_workspace_account_fkey
  foreign key (workspace_id, account_id)
  references public.accounts(workspace_id, id)
  on delete set null (account_id);
alter table public.transactions drop constraint if exists transactions_destination_account_id_fkey;
alter table public.transactions drop constraint if exists transactions_workspace_destination_account_fkey;
alter table public.transactions add constraint transactions_workspace_destination_account_fkey
  foreign key (workspace_id, destination_account_id)
  references public.accounts(workspace_id, id)
  on delete set null (destination_account_id);
alter table public.budgets drop constraint if exists budgets_category_id_fkey;
alter table public.budgets drop constraint if exists budgets_workspace_category_fkey;
alter table public.budgets add constraint budgets_workspace_category_fkey
  foreign key (workspace_id, category_id)
  references public.categories(workspace_id, id)
  on delete cascade;

-- Scope every AI artifact, including the encrypted connection, conversation,
-- proposals and aggregate telemetry, to exactly one workspace.
alter table public.personal_ai_connections add column if not exists workspace_id uuid;
update public.personal_ai_connections connection
set workspace_id = workspace.id
from public.workspaces workspace
where workspace.type = 'personal' and workspace.owner_user_id = connection.user_id
  and connection.workspace_id is null;
alter table public.personal_ai_connections alter column workspace_id set not null;
alter table public.personal_ai_connections drop constraint if exists personal_ai_connections_pkey;
alter table public.personal_ai_connections add constraint personal_ai_connections_pkey primary key (workspace_id);
alter table public.personal_ai_connections drop constraint if exists personal_ai_connections_workspace_id_fkey;
alter table public.personal_ai_connections add constraint personal_ai_connections_workspace_id_fkey
  foreign key (workspace_id) references public.workspaces(id) on delete cascade;
create index if not exists personal_ai_connections_user_workspace_idx
  on public.personal_ai_connections(user_id, workspace_id);

alter table public.personal_ai_messages add column if not exists workspace_id uuid;
update public.personal_ai_messages message
set workspace_id = workspace.id
from public.workspaces workspace
where workspace.type = 'personal' and workspace.owner_user_id = message.user_id
  and message.workspace_id is null;
alter table public.personal_ai_messages alter column workspace_id set not null;
alter table public.personal_ai_messages drop constraint if exists personal_ai_messages_workspace_id_fkey;
alter table public.personal_ai_messages add constraint personal_ai_messages_workspace_id_fkey
  foreign key (workspace_id) references public.workspaces(id) on delete cascade;
create index if not exists personal_ai_messages_workspace_created_idx
  on public.personal_ai_messages(workspace_id, created_at desc);

alter table public.personal_ai_usage_events add column if not exists workspace_id uuid;
update public.personal_ai_usage_events event
set workspace_id = workspace.id
from public.workspaces workspace
where workspace.type = 'personal' and workspace.owner_user_id = event.user_id
  and event.workspace_id is null;
alter table public.personal_ai_usage_events alter column workspace_id set not null;
alter table public.personal_ai_usage_events drop constraint if exists personal_ai_usage_events_workspace_id_fkey;
alter table public.personal_ai_usage_events add constraint personal_ai_usage_events_workspace_id_fkey
  foreign key (workspace_id) references public.workspaces(id) on delete cascade;
create index if not exists personal_ai_usage_events_workspace_created_idx
  on public.personal_ai_usage_events(workspace_id, created_at desc);

alter table public.personal_ai_usage_monthly add column if not exists workspace_id uuid;
update public.personal_ai_usage_monthly monthly
set workspace_id = workspace.id
from public.workspaces workspace
where workspace.type = 'personal' and workspace.owner_user_id = monthly.user_id
  and monthly.workspace_id is null;
alter table public.personal_ai_usage_monthly alter column workspace_id set not null;
alter table public.personal_ai_usage_monthly drop constraint if exists personal_ai_usage_monthly_pkey;
alter table public.personal_ai_usage_monthly add constraint personal_ai_usage_monthly_pkey
  primary key (workspace_id, month_start);
alter table public.personal_ai_usage_monthly drop constraint if exists personal_ai_usage_monthly_workspace_id_fkey;
alter table public.personal_ai_usage_monthly add constraint personal_ai_usage_monthly_workspace_id_fkey
  foreign key (workspace_id) references public.workspaces(id) on delete cascade;

alter table public.personal_ai_action_proposals add column if not exists workspace_id uuid;
alter table public.personal_ai_action_proposals add column if not exists consent_version text;
update public.personal_ai_action_proposals proposal
set workspace_id = workspace.id
from public.workspaces workspace
where workspace.type = 'personal' and workspace.owner_user_id = proposal.user_id
  and proposal.workspace_id is null;
alter table public.personal_ai_action_proposals alter column workspace_id set not null;
alter table public.personal_ai_action_proposals drop constraint if exists personal_ai_action_proposals_workspace_id_fkey;
alter table public.personal_ai_action_proposals add constraint personal_ai_action_proposals_workspace_id_fkey
  foreign key (workspace_id) references public.workspaces(id) on delete cascade;
create index if not exists personal_ai_action_proposals_workspace_pending_idx
  on public.personal_ai_action_proposals(workspace_id, created_at desc)
  where status = 'pending';
-- Pending drafts were created under the old user-only context. They contain no
-- committed financial change, so force fresh consent/context after migration.
update public.personal_ai_action_proposals
set status = 'cancelled', acted_at = now()
where status = 'pending';

create table if not exists public.workspace_ai_consents (
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  ai_data_sharing_version text,
  accepted_at timestamptz,
  revoked_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (user_id, workspace_id),
  check ((ai_data_sharing_version is null) = (accepted_at is null))
);
insert into public.workspace_ai_consents(user_id, workspace_id, ai_data_sharing_version, accepted_at, revoked_at)
select consent.user_id, workspace.id,
  case when consent.ai_data_sharing_version is not null
    and consent.ai_data_sharing_accepted_at is not null
    and (consent.ai_data_sharing_revoked_at is null
      or consent.ai_data_sharing_accepted_at > consent.ai_data_sharing_revoked_at)
    then consent.ai_data_sharing_version else null end,
  case when consent.ai_data_sharing_version is not null
    and consent.ai_data_sharing_accepted_at is not null
    and (consent.ai_data_sharing_revoked_at is null
      or consent.ai_data_sharing_accepted_at > consent.ai_data_sharing_revoked_at)
    then consent.ai_data_sharing_accepted_at else null end,
  consent.ai_data_sharing_revoked_at
from public.user_consents consent
join public.workspaces workspace on workspace.owner_user_id = consent.user_id and workspace.type = 'personal'
where consent.ai_data_sharing_accepted_at is not null or consent.ai_data_sharing_revoked_at is not null
on conflict (user_id, workspace_id) do nothing;

-- Update the usage rollup so the monthly count is no longer shared between
-- personal and company workspaces owned by the same authentication user.
create or replace function public.aggregate_personal_ai_usage()
returns trigger
language plpgsql security invoker
set search_path = pg_catalog, public
as $$
begin
  insert into public.personal_ai_usage_monthly as monthly (
    user_id, workspace_id, month_start, request_count, chat_count,
    input_tokens, output_tokens, updated_at
  ) values (
    new.user_id, new.workspace_id, date_trunc('month', new.created_at)::date, 1,
    case when new.kind = 'chat' then 1 else 0 end,
    coalesce(new.input_tokens, 0), coalesce(new.output_tokens, 0), new.created_at
  )
  on conflict (workspace_id, month_start) do update set
    request_count = monthly.request_count + 1,
    chat_count = monthly.chat_count + excluded.chat_count,
    input_tokens = monthly.input_tokens + excluded.input_tokens,
    output_tokens = monthly.output_tokens + excluded.output_tokens,
    updated_at = excluded.updated_at;
  return new;
end;
$$;
drop trigger if exists personal_ai_usage_events_aggregate on public.personal_ai_usage_events;
create trigger personal_ai_usage_events_aggregate after insert on public.personal_ai_usage_events
for each row execute function public.aggregate_personal_ai_usage();

-- Workspace selection is only a startup preference, never an authorization
-- boundary. Each request is authorized through the membership for its explicit
-- workspace, allowing multiple devices to keep different workspaces open.
create or replace function valurise_private.has_workspace_role(p_workspace_id uuid, p_roles text[])
returns boolean
language sql stable security definer
set search_path = pg_catalog, public, auth
set row_security = off
as $$
  select auth.uid() is not null and exists (
    select 1
    from public.workspace_memberships membership
    join public.profiles profile on profile.id = membership.user_id
    join public.workspaces workspace on workspace.id = membership.workspace_id
    where membership.workspace_id = p_workspace_id
      and membership.user_id = auth.uid()
      and membership.status = 'active'
      and membership.role = any(p_roles)
      and profile.account_status = 'active'
      and profile.account_role = 'user'
      and workspace.archived_at is null
  );
$$;
revoke all on function valurise_private.has_workspace_role(uuid, text[]) from public, anon;
grant execute on function valurise_private.has_workspace_role(uuid, text[]) to authenticated, service_role;

create or replace function valurise_private.can_read_workspace(p_workspace_id uuid)
returns boolean language sql stable security definer
set search_path = pg_catalog, valurise_private
as $$ select valurise_private.has_workspace_role(p_workspace_id, array['owner','admin','finance','accountant','viewer']) $$;
create or replace function valurise_private.can_write_workspace(p_workspace_id uuid)
returns boolean language sql stable security definer
set search_path = pg_catalog, valurise_private
as $$ select valurise_private.has_workspace_role(p_workspace_id, array['owner','admin','finance']) $$;
create or replace function valurise_private.can_manage_workspace(p_workspace_id uuid)
returns boolean language sql stable security definer
set search_path = pg_catalog, valurise_private
as $$ select valurise_private.has_workspace_role(p_workspace_id, array['owner','admin']) $$;
create or replace function valurise_private.has_personal_workspace_membership()
returns boolean language sql stable security definer
set search_path = pg_catalog, public, auth
as $$
  select coalesce(public.current_user_is_active() and exists (
    select 1
    from public.workspaces workspace
    join public.workspace_memberships membership
      on membership.workspace_id = workspace.id
    where membership.user_id = (select auth.uid())
      and workspace.type = 'personal' and workspace.archived_at is null
      and membership.status = 'active'
  ), false)
$$;
revoke all on function valurise_private.can_read_workspace(uuid), valurise_private.can_write_workspace(uuid), valurise_private.can_manage_workspace(uuid), valurise_private.has_personal_workspace_membership() from public, anon;
grant execute on function valurise_private.can_read_workspace(uuid), valurise_private.can_write_workspace(uuid), valurise_private.can_manage_workspace(uuid), valurise_private.has_personal_workspace_membership() to authenticated, service_role;
create or replace function valurise_private.is_shared_goal_member(p_goal_id uuid)
returns boolean language sql stable security definer
set search_path = pg_catalog, public, auth, valurise_private
as $$
  select valurise_private.has_personal_workspace_membership() and exists (
    select 1 from public.shared_goal_members member
    where member.shared_goal_id = p_goal_id and member.user_id = (select auth.uid())
  )
$$;
revoke all on function valurise_private.is_shared_goal_member(uuid) from public, anon;
grant execute on function valurise_private.is_shared_goal_member(uuid) to authenticated, service_role;

-- Workspace metadata is read-only to browser clients; business creation and
-- switching go through authenticated server routes.
alter table public.workspaces enable row level security;
alter table public.workspace_memberships enable row level security;
alter table public.business_profiles enable row level security;
alter table public.user_active_workspaces enable row level security;
alter table public.workspace_ai_consents enable row level security;
revoke all on public.workspaces, public.workspace_memberships, public.business_profiles,
  public.user_active_workspaces, public.workspace_ai_consents from public, anon, authenticated;
grant select on public.workspaces, public.workspace_memberships, public.business_profiles,
  public.user_active_workspaces to authenticated;
do $$ declare policy_record record;
begin
  for policy_record in select tablename, policyname from pg_policies
    where schemaname = 'public' and tablename in (
      'workspaces', 'workspace_memberships', 'business_profiles', 'user_active_workspaces'
    )
  loop execute format('drop policy %I on public.%I', policy_record.policyname, policy_record.tablename); end loop;
end $$;
create policy "members read active workspaces" on public.workspaces for select to authenticated
  using (valurise_private.can_read_workspace(id));
create policy "members read own workspace memberships" on public.workspace_memberships for select to authenticated
  using (user_id = (select auth.uid()) and status = 'active');
create policy "members read business profile" on public.business_profiles for select to authenticated
  using (valurise_private.can_read_workspace(workspace_id));
create policy "users read own active workspace selection" on public.user_active_workspaces for select to authenticated
  using (user_id = (select auth.uid()) and valurise_private.can_read_workspace(workspace_id));

-- Replace every legacy owner policy: permissive PostgreSQL policies combine
-- with OR, so leaving even one user_id policy would bypass workspace scope.
do $$
declare table_name text; policy_record record;
begin
  foreach table_name in array array[
    'accounts', 'categories', 'transactions', 'budgets', 'goals',
    'financial_institutions', 'credit_cards'
  ] loop
    for policy_record in select policyname from pg_policies
      where schemaname = 'public' and tablename = table_name
    loop
      execute format('drop policy %I on public.%I', policy_record.policyname, table_name);
    end loop;
    execute format('alter table public.%I enable row level security', table_name);
    execute format('create policy %I on public.%I for select to authenticated using (valurise_private.can_read_workspace(workspace_id))', table_name || '_workspace_read', table_name);
    execute format('create policy %I on public.%I for all to authenticated using (valurise_private.can_write_workspace(workspace_id)) with check (valurise_private.can_write_workspace(workspace_id))', table_name || '_workspace_write', table_name);
  end loop;
end $$;

do $$ declare policy_record record;
begin
  for policy_record in select policyname from pg_policies where schemaname='public' and tablename='user_financial_state'
  loop execute format('drop policy %I on public.user_financial_state', policy_record.policyname); end loop;
end $$;
alter table public.user_financial_state enable row level security;
revoke all on public.user_financial_state from public, anon;
grant select, insert, update on public.user_financial_state to authenticated;
grant all on public.workspaces, public.workspace_memberships, public.business_profiles,
  public.user_active_workspaces, public.user_financial_state, public.accounts,
  public.categories, public.transactions, public.budgets, public.goals,
  public.financial_institutions, public.credit_cards to service_role;
create policy "active workspace members read financial state" on public.user_financial_state for select to authenticated
  using (valurise_private.can_read_workspace(workspace_id));
create policy "finance roles write financial state" on public.user_financial_state for all to authenticated
  using (valurise_private.can_write_workspace(workspace_id))
  with check (valurise_private.can_write_workspace(workspace_id));

-- AI keys remain server-only. Conversation reads are scoped by workspace and
-- active membership; all writes and consent changes remain server-side.
do $$ declare policy_record record;
begin
  for policy_record in select tablename, policyname from pg_policies
    where schemaname='public' and tablename in ('personal_ai_messages','personal_ai_usage_events','personal_ai_usage_monthly')
  loop execute format('drop policy %I on public.%I', policy_record.policyname, policy_record.tablename); end loop;
end $$;
alter table public.personal_ai_connections enable row level security;
alter table public.personal_ai_messages enable row level security;
alter table public.personal_ai_action_proposals enable row level security;
alter table public.personal_ai_usage_events enable row level security;
alter table public.personal_ai_usage_monthly enable row level security;
revoke all on public.personal_ai_connections, public.personal_ai_action_proposals,
  public.workspace_ai_consents from public, anon, authenticated;
revoke all on public.personal_ai_messages, public.personal_ai_usage_events,
  public.personal_ai_usage_monthly from public, anon;
grant select on public.personal_ai_messages, public.personal_ai_usage_events,
  public.personal_ai_usage_monthly to authenticated;
grant all on public.personal_ai_connections, public.personal_ai_messages,
  public.personal_ai_action_proposals, public.personal_ai_usage_events,
  public.personal_ai_usage_monthly, public.workspace_ai_consents to service_role;
create policy "users read own workspace ai messages" on public.personal_ai_messages for select to authenticated
  using (user_id = (select auth.uid()) and valurise_private.can_read_workspace(workspace_id));
create policy "users read own workspace ai usage" on public.personal_ai_usage_events for select to authenticated
  using (user_id = (select auth.uid()) and valurise_private.can_read_workspace(workspace_id));
create policy "members read active workspace monthly ai usage" on public.personal_ai_usage_monthly for select to authenticated
  using (valurise_private.can_read_workspace(workspace_id));

-- Shared goals remain a personal feature. Restrict both reads and writes to
-- the caller's active personal workspace, including SECURITY DEFINER RPCs.
do $$ declare policy_record record;
begin
  for policy_record in select tablename, policyname from pg_policies
    where schemaname = 'public' and tablename in (
      'shared_goals', 'shared_goal_members', 'shared_goal_invites', 'shared_goal_contributions'
    )
  loop execute format('drop policy %I on public.%I', policy_record.policyname, policy_record.tablename); end loop;
end $$;
create policy "personal workspace members read shared goals" on public.shared_goals for select to authenticated
  using (valurise_private.is_shared_goal_member(shared_goals.id));
create policy "personal workspace users create shared goals" on public.shared_goals for insert to authenticated
  with check (valurise_private.has_personal_workspace_membership() and owner_id = (select auth.uid()));
create policy "personal workspace owners update shared goals" on public.shared_goals for update to authenticated
  using (valurise_private.has_personal_workspace_membership() and owner_id = (select auth.uid()))
  with check (valurise_private.has_personal_workspace_membership() and owner_id = (select auth.uid()));
create policy "personal workspace owners delete shared goals" on public.shared_goals for delete to authenticated
  using (valurise_private.has_personal_workspace_membership() and owner_id = (select auth.uid()));
create policy "personal workspace members read shared goal members" on public.shared_goal_members for select to authenticated
  using (valurise_private.is_shared_goal_member(shared_goal_members.shared_goal_id));
create policy "personal workspace members leave shared goals" on public.shared_goal_members for delete to authenticated
  using (valurise_private.has_personal_workspace_membership() and user_id = (select auth.uid()) and role = 'member');
create policy "personal workspace participants read shared goal invites" on public.shared_goal_invites for select to authenticated
  using (valurise_private.has_personal_workspace_membership() and (inviter_id = (select auth.uid()) or recipient_id = (select auth.uid())));
create policy "personal workspace recipients respond to invites" on public.shared_goal_invites for update to authenticated
  using (valurise_private.has_personal_workspace_membership() and recipient_id = (select auth.uid()) and status = 'pending')
  with check (valurise_private.has_personal_workspace_membership() and recipient_id = (select auth.uid()) and status in ('accepted', 'declined'));
create policy "personal workspace members read goal contributions" on public.shared_goal_contributions for select to authenticated
  using (valurise_private.is_shared_goal_member(shared_goal_contributions.shared_goal_id));
create policy "personal workspace members add own goal contribution" on public.shared_goal_contributions for insert to authenticated
  with check (valurise_private.is_shared_goal_member(shared_goal_contributions.shared_goal_id) and user_id = (select auth.uid()));
create policy "personal workspace members remove own goal contribution" on public.shared_goal_contributions for delete to authenticated
  using (valurise_private.has_personal_workspace_membership() and user_id = (select auth.uid()));
-- Invitation acceptance must remain atomic in the SECURITY DEFINER RPC; direct
-- column updates could otherwise retarget an invite to a different goal.
revoke insert, update, delete on public.shared_goal_invites from authenticated;
revoke insert, update, delete on public.shared_goal_contributions from authenticated;

-- SECURITY DEFINER routines for legacy shared-goal features bypass RLS. These
-- table triggers enforce the workspace context even when those RPCs are used.
create or replace function valurise_private.guard_personal_shared_goal_write()
returns trigger language plpgsql security invoker
set search_path = pg_catalog, valurise_private, auth
as $$
begin
  if auth.role() = 'service_role' then
    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;
  if not valurise_private.has_personal_workspace_membership() then
    raise exception 'active personal workspace required' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then return old; else return new; end if;
end;
$$;
revoke all on function valurise_private.guard_personal_shared_goal_write() from public, anon, authenticated;
drop trigger if exists workspace_guard_shared_goals on public.shared_goals;
create trigger workspace_guard_shared_goals before insert or update or delete on public.shared_goals
  for each row execute function valurise_private.guard_personal_shared_goal_write();
drop trigger if exists workspace_guard_shared_goal_members on public.shared_goal_members;
create trigger workspace_guard_shared_goal_members before insert or update or delete on public.shared_goal_members
  for each row execute function valurise_private.guard_personal_shared_goal_write();
drop trigger if exists workspace_guard_shared_goal_invites on public.shared_goal_invites;
create trigger workspace_guard_shared_goal_invites before insert or update or delete on public.shared_goal_invites
  for each row execute function valurise_private.guard_personal_shared_goal_write();
drop trigger if exists workspace_guard_shared_goal_contributions on public.shared_goal_contributions;
create trigger workspace_guard_shared_goal_contributions before insert or update or delete on public.shared_goal_contributions
  for each row execute function valurise_private.guard_personal_shared_goal_write();

create or replace function valurise_private.guard_financial_state_workspace_write()
returns trigger language plpgsql security invoker
set search_path = pg_catalog, valurise_private
as $$
declare target_workspace_id uuid; target_workspace_type text;
begin
  if auth.role() = 'service_role' then
    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;
  target_workspace_id := case when tg_op = 'DELETE' then old.workspace_id else new.workspace_id end;
  select workspace.type into target_workspace_type from public.workspaces workspace where workspace.id = target_workspace_id;
  if not valurise_private.can_write_workspace(target_workspace_id)
    or (tg_op = 'UPDATE' and old.workspace_id is distinct from new.workspace_id) then
    raise exception 'active workspace finance permission required' using errcode = '42501';
  end if;
  if (tg_op = 'INSERT' and (
      (target_workspace_type = 'personal' and new.user_id is distinct from (select auth.uid()))
      or (target_workspace_type = 'business' and new.user_id is not null)
    )) or (tg_op = 'UPDATE' and new.user_id is distinct from old.user_id) then
    raise exception 'financial state attribution is immutable' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then return old; else return new; end if;
end;
$$;
revoke all on function valurise_private.guard_financial_state_workspace_write() from public, anon, authenticated;
-- Existing browser sessions may continue writing by user_id while the new
-- deployment is rolling out. Resolve only a personal workspace and let the
-- same workspace authorization trigger validate the resulting row.
create or replace function valurise_private.fill_legacy_financial_state_workspace()
returns trigger language plpgsql security invoker
set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'INSERT' and new.workspace_id is null then
    if new.user_id is null then
      raise exception 'workspace_id required' using errcode = '23502';
    end if;
    select workspace.id into new.workspace_id
    from public.workspaces workspace
    where workspace.type = 'personal'
      and workspace.owner_user_id = new.user_id
      and workspace.archived_at is null;
    if new.workspace_id is null then
      raise exception 'personal workspace required for legacy state write' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function valurise_private.fill_legacy_financial_state_workspace() from public, anon, authenticated;
drop trigger if exists workspace_compat_financial_state on public.user_financial_state;
create trigger workspace_compat_financial_state before insert on public.user_financial_state
  for each row execute function valurise_private.fill_legacy_financial_state_workspace();
drop trigger if exists workspace_guard_financial_state on public.user_financial_state;
create trigger workspace_guard_financial_state before insert or update or delete on public.user_financial_state
  for each row execute function valurise_private.guard_financial_state_workspace_write();

create or replace function valurise_private.guard_normalized_finance_workspace_write()
returns trigger language plpgsql security invoker
set search_path = pg_catalog, valurise_private, auth
as $$
declare target_workspace_id uuid;
begin
  if auth.role() = 'service_role' then
    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;
  target_workspace_id := case when tg_op = 'DELETE' then old.workspace_id else new.workspace_id end;
  if not valurise_private.can_write_workspace(target_workspace_id) then
    raise exception 'active workspace finance permission required' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' and new.user_id is distinct from (select auth.uid()) then
    raise exception 'financial record creator must be the authenticated user' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and (
    new.workspace_id is distinct from old.workspace_id or new.user_id is distinct from old.user_id
  ) then
    raise exception 'financial record workspace and creator are immutable' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then return old; else return new; end if;
end;
$$;
revoke all on function valurise_private.guard_normalized_finance_workspace_write() from public, anon, authenticated;
do $$ declare table_name text;
begin
  foreach table_name in array array[
    'accounts', 'categories', 'transactions', 'budgets', 'goals',
    'financial_institutions', 'credit_cards'
  ] loop
    execute format('drop trigger if exists workspace_guard_%I on public.%I', table_name, table_name);
    execute format('create trigger workspace_guard_%I before insert or update or delete on public.%I for each row execute function valurise_private.guard_normalized_finance_workspace_write()', table_name, table_name);
  end loop;
end $$;

-- Atomic business creation. CNPJ validation and uniqueness are checked again
-- in Postgres, not trusted from the browser or route alone.
create or replace function public.create_business_workspace(
  p_user_id uuid, p_trade_name text, p_legal_name text, p_cnpj text
)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare
  workspace_id uuid;
  normalized_cnpj text := regexp_replace(coalesce(p_cnpj, ''), '[^0-9]', '', 'g');
  safe_trade_name text := trim(coalesce(p_trade_name, ''));
  safe_legal_name text := trim(coalesce(p_legal_name, ''));
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'server authorization required' using errcode = '42501';
  end if;
  if p_user_id is null or not exists (
    select 1 from public.profiles profile where profile.id = p_user_id
      and profile.account_status = 'active' and profile.account_role = 'user'
  ) then raise exception 'active user required' using errcode = '42501'; end if;
  if char_length(safe_trade_name) not between 2 and 120
     or char_length(safe_legal_name) not between 2 and 180
     or not public.valurise_is_valid_cnpj(normalized_cnpj) then
    raise exception 'invalid business profile' using errcode = '22023';
  end if;
  insert into public.workspaces(type, display_name, owner_user_id)
  values ('business', safe_trade_name, p_user_id) returning id into workspace_id;
  insert into public.workspace_memberships(workspace_id, user_id, role, status)
  values (workspace_id, p_user_id, 'owner', 'active');
  insert into public.business_profiles(workspace_id, trade_name, legal_name, cnpj)
  values (workspace_id, safe_trade_name, safe_legal_name, normalized_cnpj);
  insert into public.user_financial_state(workspace_id, state, version)
  values (workspace_id, '{"data":{"categories":[],"institutions":[],"onboarded":false},"transactions":[],"profile":{}}'::jsonb, 1);
  insert into public.user_active_workspaces(user_id, workspace_id, updated_at)
  values (p_user_id, workspace_id, now())
  on conflict (user_id) do update set workspace_id = excluded.workspace_id, updated_at = excluded.updated_at;
  return jsonb_build_object('id', workspace_id, 'type', 'business', 'display_name', safe_trade_name, 'role', 'owner');
end;
$$;
revoke all on function public.create_business_workspace(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.create_business_workspace(uuid, text, text, text) to service_role;

-- Avoid using the old user-only AI action RPC for a business workspace. The
-- application will call this workspace-aware function after server validation.
create or replace function public.confirm_workspace_ai_transaction(
  p_proposal_id uuid, p_user_id uuid, p_workspace_id uuid, p_expected_consent_version text
)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare
  action_row public.personal_ai_action_proposals%rowtype;
  connection_row public.personal_ai_connections%rowtype;
  consent_row public.workspace_ai_consents%rowtype;
  financial_state jsonb;
  current_version integer;
  new_version integer;
  transaction_id text := gen_random_uuid()::text;
  transaction_row jsonb;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'server authorization required' using errcode = '42501'; end if;
  if not exists (select 1 from public.workspace_memberships membership
    join public.profiles profile on profile.id = membership.user_id
    where membership.workspace_id = p_workspace_id and membership.user_id = p_user_id
      and membership.role in ('owner','admin','finance') and membership.status='active'
      and profile.account_role='user' and profile.account_status='active') then
    raise exception 'workspace access denied' using errcode = '42501';
  end if;
  select * into action_row from public.personal_ai_action_proposals
    where id = p_proposal_id and user_id = p_user_id and workspace_id = p_workspace_id for update;
  if not found then raise exception 'proposal not found' using errcode = 'P0002'; end if;
  if action_row.status <> 'pending' then return jsonb_build_object('ok', false, 'reason', 'not_pending'); end if;
  if action_row.expires_at <= clock_timestamp() then
    update public.personal_ai_action_proposals set status='expired', acted_at=clock_timestamp() where id=action_row.id;
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;
  select * into connection_row from public.personal_ai_connections connection
    where connection.workspace_id = p_workspace_id;
  select * into consent_row from public.workspace_ai_consents consent
    where consent.workspace_id = p_workspace_id and consent.user_id = p_user_id;
  if not coalesce(connection_row.actions_enabled, false) or not coalesce(connection_row.insights_enabled, false)
     or consent_row.ai_data_sharing_version is distinct from p_expected_consent_version
     or action_row.consent_version is distinct from p_expected_consent_version
     or consent_row.accepted_at is null or action_row.consent_version is null then
    update public.personal_ai_action_proposals set status='cancelled', acted_at=clock_timestamp() where id=action_row.id;
    return jsonb_build_object('ok', false, 'reason', 'permission_revoked');
  end if;
  select financial.state, financial.version into financial_state, current_version
    from public.user_financial_state financial where financial.workspace_id=p_workspace_id for update;
  if not found then
    update public.personal_ai_action_proposals set status='stale', acted_at=clock_timestamp() where id=action_row.id;
    return jsonb_build_object('ok', false, 'reason', 'state_missing');
  end if;
  if current_version <> action_row.expected_state_version then
    update public.personal_ai_action_proposals set status='stale', acted_at=clock_timestamp() where id=action_row.id;
    return jsonb_build_object('ok', false, 'reason', 'state_changed');
  end if;
  if action_row.action_type not in ('income','expense')
    or action_row.transaction_date > (clock_timestamp() at time zone 'America/Sao_Paulo')::date
    or not exists (select 1 from jsonb_array_elements_text(
      case when jsonb_typeof(financial_state #> '{data,categories}')='array' then financial_state #> '{data,categories}' else '[]'::jsonb end
    ) category(value) where category.value=action_row.category)
    or not exists (select 1 from jsonb_array_elements(
      case when jsonb_typeof(financial_state #> '{data,institutions}')='array' then financial_state #> '{data,institutions}' else '[]'::jsonb end
    ) institution(value) cross join lateral jsonb_array_elements(
      case when jsonb_typeof(institution.value->'accounts')='array' then institution.value->'accounts' else '[]'::jsonb end
    ) account(value) where coalesce(institution.value->>'name','') || ' • ' || coalesce(account.value->>'name','')=action_row.account_label
      and not exists (select 1 from jsonb_array_elements(
        case when jsonb_typeof(institution.value->'cards')='array' then institution.value->'cards' else '[]'::jsonb end
      ) card(value) where coalesce(institution.value->>'name','') || ' • ' || coalesce(card.value->>'name','')=action_row.account_label)) then
    update public.personal_ai_action_proposals set status='stale', acted_at=clock_timestamp() where id=action_row.id;
    return jsonb_build_object('ok', false, 'reason', 'details_changed');
  end if;
  transaction_row := jsonb_build_object(
    'id', transaction_id, 'type', action_row.action_type, 'subtype', action_row.action_type,
    'amountCents', action_row.amount_cents, 'category', action_row.category,
    'account', action_row.account_label, 'description', action_row.description,
    'date', action_row.transaction_date::text || 'T12:00:00.000Z',
    'createdAt', to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
  new_version := current_version + 1;
  update public.user_financial_state set state=jsonb_set(
    financial_state, '{transactions}',
    (case when jsonb_typeof(financial_state->'transactions')='array' then financial_state->'transactions' else '[]'::jsonb end) || jsonb_build_array(transaction_row), true
  ), version=new_version where workspace_id=p_workspace_id;
  update public.personal_ai_action_proposals set status='approved', acted_at=clock_timestamp(), executed_transaction_id=transaction_id where id=action_row.id;
  return jsonb_build_object('ok', true, 'version', new_version, 'transaction', transaction_row);
end;
$$;
revoke all on function public.confirm_workspace_ai_transaction(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.confirm_workspace_ai_transaction(uuid, uuid, uuid, text) to service_role;

commit;
