-- Keep a single permissive SELECT policy per finance table and index the
-- workspace-scoped foreign keys used by deletes and joins.
begin;

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'accounts', 'categories', 'transactions', 'budgets', 'goals',
    'financial_institutions', 'credit_cards'
  ] loop
    execute format('drop policy if exists %I on public.%I', table_name || '_workspace_write', table_name);
    execute format(
      'create policy %I on public.%I for insert to authenticated with check (valurise_private.can_write_workspace(workspace_id))',
      table_name || '_workspace_insert', table_name
    );
    execute format(
      'create policy %I on public.%I for update to authenticated using (valurise_private.can_write_workspace(workspace_id)) with check (valurise_private.can_write_workspace(workspace_id))',
      table_name || '_workspace_update', table_name
    );
    execute format(
      'create policy %I on public.%I for delete to authenticated using (valurise_private.can_write_workspace(workspace_id))',
      table_name || '_workspace_delete', table_name
    );
  end loop;
end;
$$;

drop policy if exists "finance roles write financial state" on public.user_financial_state;
create policy "finance roles insert financial state" on public.user_financial_state for insert to authenticated
  with check (valurise_private.can_write_workspace(workspace_id));
create policy "finance roles update financial state" on public.user_financial_state for update to authenticated
  using (valurise_private.can_write_workspace(workspace_id))
  with check (valurise_private.can_write_workspace(workspace_id));

-- These tables are intentionally server-only. Explicit deny policies make the
-- no-browser-access contract visible to future grants and database linting.
do $$
declare table_name text;
begin
  foreach table_name in array array[
    'personal_ai_connections', 'personal_ai_action_proposals',
    'workspace_ai_consents', 'public_rate_limits'
  ] loop
    execute format('drop policy if exists %I on public.%I', table_name || '_server_only', table_name);
    execute format(
      'create policy %I on public.%I for all to anon, authenticated using (false) with check (false)',
      table_name || '_server_only', table_name
    );
  end loop;
end;
$$;

create index if not exists accounts_workspace_institution_idx
  on public.accounts(workspace_id, institution_id);
create index if not exists budgets_user_id_idx on public.budgets(user_id);
create index if not exists categories_user_id_idx on public.categories(user_id);
create index if not exists financial_institutions_user_id_idx
  on public.financial_institutions(user_id);
create index if not exists personal_ai_usage_monthly_user_id_idx
  on public.personal_ai_usage_monthly(user_id);
create index if not exists transactions_workspace_account_idx
  on public.transactions(workspace_id, account_id);
create index if not exists transactions_workspace_category_idx
  on public.transactions(workspace_id, category_id);
create index if not exists transactions_workspace_destination_account_idx
  on public.transactions(workspace_id, destination_account_id);
create index if not exists workspace_ai_consents_workspace_idx
  on public.workspace_ai_consents(workspace_id);

commit;
