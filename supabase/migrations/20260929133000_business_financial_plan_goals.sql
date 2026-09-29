-- Strategic annual goals are versioned in the existing workspace-scoped,
-- append-only business assumptions ledger. No existing rows are rewritten.
begin;

alter table public.business_financial_assumptions
  drop constraint if exists business_financial_assumptions_metric_key_check;

alter table public.business_financial_assumptions
  add constraint business_financial_assumptions_metric_key_check
  check (metric_key in (
    'monthly_revenue', 'direct_costs', 'fixed_expenses', 'variable_expenses',
    'payroll', 'taxes', 'receivables', 'payables', 'initial_cash',
    'annual_revenue_goal', 'annual_result_goal', 'minimum_cash', 'expense_limit', 'reserve_target'
  ));

commit;
