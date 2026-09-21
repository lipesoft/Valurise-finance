-- Adds the institution → account / credit card hierarchy without deleting legacy data.
create table if not exists public.financial_institutions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  color text,
  icon text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (user_id, name)
);

alter table public.accounts
  add column if not exists institution_id uuid references public.financial_institutions(id) on delete set null;

-- Preserve old accounts that stored an institution as text.
insert into public.financial_institutions (user_id, name)
select distinct user_id, trim(institution)
from public.accounts
where institution is not null and trim(institution) <> ''
on conflict (user_id, name) do nothing;

update public.accounts account
set institution_id = institution_row.id
from public.financial_institutions institution_row
where account.institution_id is null
  and account.user_id = institution_row.user_id
  and lower(trim(coalesce(account.institution, ''))) = lower(institution_row.name);

create table if not exists public.credit_cards (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  institution_id uuid not null references public.financial_institutions(id) on delete cascade,
  name text,
  limit_cents bigint not null check (limit_cents >= 0),
  closing_day smallint check (closing_day between 1 and 31),
  due_day smallint check (due_day between 1 and 31),
  best_purchase_day smallint check (best_purchase_day between 1 and 31),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists accounts_institution_idx on public.accounts(institution_id);
create index if not exists credit_cards_user_institution_idx on public.credit_cards(user_id, institution_id);

alter table public.financial_institutions enable row level security;
alter table public.credit_cards enable row level security;

create policy "institutions owner" on public.financial_institutions for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "credit cards owner" on public.credit_cards for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

grant select, insert, update, delete on public.financial_institutions, public.credit_cards to authenticated;
