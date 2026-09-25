-- Business-only finance settings are stored separately from the transaction
-- ledger. Changes are append-only so prior reported/estimated values remain
-- auditable and can be compared with later actual movements.
begin;

alter table public.business_profiles
  add column if not exists activity_start_date date,
  add column if not exists cnae text,
  add column if not exists tax_regime text,
  add column if not exists accountant_name text,
  add column if not exists management_close_day smallint,
  add column if not exists default_currency text not null default 'BRL',
  add column if not exists timezone text not null default 'America/Sao_Paulo';

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.business_profiles'::regclass and conname = 'business_profiles_cnae_valid') then
    alter table public.business_profiles add constraint business_profiles_cnae_valid
      check (cnae is null or cnae ~ '^[0-9]{7}$');
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.business_profiles'::regclass and conname = 'business_profiles_tax_regime_valid') then
    alter table public.business_profiles add constraint business_profiles_tax_regime_valid
      check (tax_regime is null or tax_regime in ('mei', 'simples_nacional', 'lucro_presumido', 'lucro_real', 'other'));
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.business_profiles'::regclass and conname = 'business_profiles_close_day_valid') then
    alter table public.business_profiles add constraint business_profiles_close_day_valid
      check (management_close_day is null or management_close_day between 1 and 31);
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.business_profiles'::regclass and conname = 'business_profiles_currency_valid') then
    alter table public.business_profiles add constraint business_profiles_currency_valid
      check (default_currency ~ '^[A-Z]{3}$');
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.business_profiles'::regclass and conname = 'business_profiles_timezone_valid') then
    alter table public.business_profiles add constraint business_profiles_timezone_valid
      check (char_length(timezone) between 1 and 80);
  end if;
end;
$$;

create or replace function valurise_private.is_business_workspace(p_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1 from public.workspaces workspace
    where workspace.id = p_workspace_id
      and workspace.type = 'business'
      and workspace.archived_at is null
  );
$$;
revoke all on function valurise_private.is_business_workspace(uuid) from public, anon;
grant execute on function valurise_private.is_business_workspace(uuid) to authenticated, service_role;

create table if not exists public.business_financial_assumptions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  metric_key text not null check (metric_key in (
    'monthly_revenue', 'direct_costs', 'fixed_expenses', 'variable_expenses',
    'payroll', 'taxes', 'receivables', 'payables', 'initial_cash'
  )),
  amount_cents bigint not null check (amount_cents between 0 and 9007199254740991),
  nature text not null check (nature in ('reported', 'estimated')),
  source text not null default 'manual' check (source = 'manual'),
  reference_month date not null check (extract(day from reference_month) = 1),
  is_cleared boolean not null default false,
  created_by uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now(),
  request_id uuid not null default gen_random_uuid(),
  constraint business_financial_assumptions_idempotent unique (workspace_id, request_id, metric_key)
);

create index if not exists business_financial_assumptions_period_idx
  on public.business_financial_assumptions(workspace_id, metric_key, reference_month desc, created_at desc);
create index if not exists business_financial_assumptions_author_idx
  on public.business_financial_assumptions(created_by, created_at desc);

alter table public.business_financial_assumptions enable row level security;
revoke all on public.business_financial_assumptions from anon, authenticated;
grant select, insert on public.business_financial_assumptions to authenticated;
drop policy if exists "members read business financial assumptions" on public.business_financial_assumptions;
create policy "members read business financial assumptions" on public.business_financial_assumptions
  for select to authenticated
  using (valurise_private.can_read_workspace(workspace_id)
    and (select valurise_private.is_business_workspace(workspace_id)));
drop policy if exists "finance roles append business assumptions" on public.business_financial_assumptions;
create policy "finance roles append business assumptions" on public.business_financial_assumptions
  for insert to authenticated
  with check (valurise_private.can_write_workspace(workspace_id)
    and (select valurise_private.is_business_workspace(workspace_id))
    and created_by = (select auth.uid()));

drop policy if exists "finance roles update business profile" on public.business_profiles;
create policy "finance roles update business profile" on public.business_profiles
  for update to authenticated
  using (valurise_private.can_write_workspace(workspace_id)
    and (select valurise_private.is_business_workspace(workspace_id)))
  with check (valurise_private.can_write_workspace(workspace_id)
    and (select valurise_private.is_business_workspace(workspace_id)));
grant update (email, phone, postal_code, street, number, address_complement,
  neighborhood, city, state, activity_start_date, cnae, tax_regime,
  accountant_name, management_close_day, default_currency, timezone, updated_at)
  on public.business_profiles to authenticated;

commit;
