"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { ArrowDownLeft, ArrowUpRight, Building2, Info, Save } from "lucide-react";
import { accountBalance, formatBRL, type FinanceTransaction } from "@/lib/finance";
import { HelpHint } from "@/components/help-hint";
import { AnimatedCard } from "@/components/motion";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import styles from "@/components/business-finance.module.css";
import {
  BUSINESS_ASSUMPTION_KEYS,
  BUSINESS_PLAN_GOAL_KEYS,
  buildBusinessCashEvents,
  calculateAnnualRevenueOutlook,
  calculateBusinessFinanceSnapshot,
  formatBusinessMoney,
  parseBusinessMoneyToCents,
  type BusinessAssumption,
  type BusinessAssumptionKey,
  type BusinessCashSchedule,
  type BusinessPlanGoal,
  type BusinessPlanGoalKey,
  type BusinessFinanceSnapshot,
  type FinancialDataNature,
  projectedBusinessCash,
} from "@/lib/business-finance";
import type { PlannedReceivable } from "@/lib/receivables";

type Profile = {
  legal_name: string; trade_name: string; cnpj: string; email: string | null; phone: string | null;
  postal_code: string | null; street: string | null; number: string | null; address_complement: string | null;
  neighborhood: string | null; city: string | null; state: string | null; activity_start_date: string | null;
  cnae: string | null; tax_regime: "mei" | "simples_nacional" | "lucro_presumido" | "lucro_real" | "other" | null;
  accountant_name: string | null; management_close_day: number | null; default_currency: string; timezone: string;
};
type AssumptionRecord = Partial<Record<BusinessAssumptionKey, BusinessAssumption | null>>;
type PlanGoalRecord = Partial<Record<BusinessPlanGoalKey, BusinessPlanGoal | null>>;
type BusinessInstitutionData = {
  institutions?: { name: string; accounts: { name: string; balance: number }[] }[];
  recurringBills?: BusinessCashSchedule[];
  plannedReceivables?: PlannedReceivable[];
};

const blankProfile: Profile = {
  legal_name: "", trade_name: "", cnpj: "", email: null, phone: null, postal_code: null, street: null,
  number: null, address_complement: null, neighborhood: null, city: null, state: null,
  activity_start_date: null, cnae: null, tax_regime: null, accountant_name: null,
  management_close_day: null, default_currency: "BRL", timezone: "America/Sao_Paulo",
};
const assumptionLabels: Record<BusinessAssumptionKey, string> = {
  monthly_revenue: "Faturamento médio mensal",
  direct_costs: "Custos diretos médios",
  fixed_expenses: "Despesas fixas médias",
  variable_expenses: "Despesas variáveis médias",
  payroll: "Folha e pessoal médios",
  taxes: "Impostos provisionados médios",
  receivables: "Contas a receber estimadas",
  payables: "Contas a pagar estimadas",
  initial_cash: "Saldo inicial informado",
};
const planGoalLabels: Record<BusinessPlanGoalKey, string> = {
  annual_revenue_goal: "Meta de faturamento anual",
  annual_result_goal: "Meta anual de resultado",
  minimum_cash: "Caixa mínimo desejado",
  expense_limit: "Limite anual de despesas",
  reserve_target: "Reserva empresarial desejada",
};
const natureLabels: Record<FinancialDataNature, string> = {
  actual: "Realizado", reported: "Informado", estimated: "Estimado", projected: "Projetado", mixed: "Misto",
};
const natureDescriptions: Record<FinancialDataNature, string> = {
  actual: "Calculado com base em valores e movimentações já registrados.",
  reported: "Valor de referência informado manualmente no perfil financeiro da empresa.",
  estimated: "Estimativa gerencial baseada nas referências informadas; não representa um lançamento confirmado.",
  projected: "Valor futuro planejado, ainda não confirmado como recebido ou pago.",
  mixed: "Combina valores registrados com referências informadas ou estimadas.",
};

function monthKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}
function centsInput(amount: number | null | undefined) {
  return amount === null || amount === undefined ? "" : (amount / 100).toFixed(2).replace(".", ",");
}
function monthlyMoney(cents: number | null, currency = "BRL") {
  return formatBusinessMoney(cents, currency);
}
function displayMonthlyMoney(cents: number | null, currency = "BRL") {
  return cents === null ? "Sem dados" : monthlyMoney(cents, currency);
}
function exactMonthlyMoney(cents: number | null, currency = "BRL") {
  if (cents === null) return "Sem dados suficientes";
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency }).format(cents / 100);
}
async function authorizedRequest(workspaceId: string, path: string, init?: RequestInit) {
  const supabase = getSupabaseBrowserClient();
  const { data } = await supabase?.auth.getSession() || {};
  const token = data?.session?.access_token;
  if (!token) throw new Error("Sua sessão expirou. Entre novamente para continuar.");
  const response = await fetch(path, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Valurise-Workspace-Id": workspaceId,
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
    signal: init?.signal || AbortSignal.timeout(15_000),
    cache: "no-store",
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof payload.error === "string" ? payload.error : "Não foi possível carregar os dados empresariais.");
  return payload;
}
function emptySnapshot(period: string): BusinessFinanceSnapshot {
  return calculateBusinessFinanceSnapshot({ period, transactions: [], assumptions: [], cashAvailableCents: null });
}
function natureBadge(nature: FinancialDataNature | null) {
  if (!nature) return null;
  return <span data-nature={nature} title={natureDescriptions[nature]} aria-label={`${natureLabels[nature]}. ${natureDescriptions[nature]}`} className={`${styles.statusBadge} whitespace-nowrap text-[10px] font-medium`}>{natureLabels[nature]}</span>;
}
function natureTone(nature: FinancialDataNature | null) {
  if (nature === "actual") return styles.metricActual;
  if (nature === "projected") return styles.metricProjected;
  return nature ? styles.metricForecast : styles.metricUnknown;
}
function Metric({ label, item, currency = "BRL" }: { label: string; item: { amountCents: number | null; nature: FinancialDataNature | null; explanation: string }; currency?: string }) {
  const tone = natureTone(item.nature);
  const amountLabel = exactMonthlyMoney(item.amountCents, currency);
  return <article data-nature={item.nature || "none"} className={`min-w-0 rounded-2xl p-4 ${styles.metricCard} ${tone}`} title={item.explanation}>
    <h3 className="min-h-10 text-sm font-semibold leading-5 text-[var(--fg)]">{label}</h3>
    <p data-metric-value aria-label={amountLabel} title={item.amountCents === null ? undefined : amountLabel} className={`mt-1 font-semibold tracking-tight ${item.amountCents === null ? "break-words text-base leading-tight sm:text-lg" : "whitespace-nowrap text-lg tabular-nums sm:text-xl 2xl:text-2xl"}`}>{displayMonthlyMoney(item.amountCents, currency)}</p>
    <div className="mt-2 flex min-w-0 items-center justify-between gap-2"><details className="muted min-w-0 text-[11px]"><summary className="inline-flex cursor-pointer list-none items-center gap-1"><Info size={12}/> Como calculamos?</summary><p className="mt-1 leading-5">{item.explanation}</p></details>{natureBadge(item.nature)}</div>
  </article>;
}
type DashboardTotals = {
  balanceCents: number;
  incomeCents: number;
  expenseCents: number;
  investmentCents: number;
};
function TotalValue({ label, value, currency }: { label: string; value: number; currency: string }) {
  return <div className="min-w-0">
    <p className="muted text-xs">{label}</p>
    <b title={exactMonthlyMoney(value, currency)} className="mt-1 block whitespace-nowrap text-[clamp(.72rem,3.1vw,1rem)] leading-tight tracking-tight">{monthlyMoney(value, currency)}</b>
  </div>;
}
function TotalFinancialMetric({ label, value, currency, negative = false, accent = false, help }: { label: string; value: number; currency: string; negative?: boolean; accent?: boolean; help?: string }) {
  const amount = negative ? -Math.abs(value) : value;
  return <div className="min-w-0 rounded-xl bg-[var(--panel2)] px-3 py-2.5" title={help}>
    <p className="muted text-[10px]">{label}{help ? " · ⓘ" : ""}</p>
    <b title={exactMonthlyMoney(amount, currency)} className={`mt-0.5 block truncate text-[13px] ${negative ? "text-[var(--danger)]" : accent ? "text-[var(--accent)]" : ""}`}>{monthlyMoney(amount, currency)}</b>
  </div>;
}
function BusinessTotalCard({ summary, total, availableBalanceCents, committedCents, freeToSpendCents, scheduledReceivablesCents, currency }: {
  summary: DashboardTotals; total: DashboardTotals; availableBalanceCents: number; committedCents: number;
  freeToSpendCents: number; scheduledReceivablesCents: number; currency: string;
}) {
  return <section aria-label="Total da empresa"><AnimatedCard className="panel mt-5 rounded-3xl p-6">
    <p className="muted text-sm">Total</p>
    <p className="mt-2 text-4xl font-semibold" title={exactMonthlyMoney(total.balanceCents, currency)}>{monthlyMoney(total.balanceCents, currency)}</p>
    <div className="mt-5 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-[var(--border)] pt-4 sm:grid-cols-5 sm:gap-3">
      <TotalValue label="Entrou" value={summary.incomeCents} currency={currency}/>
      <TotalValue label="Consumo" value={summary.expenseCents} currency={currency}/>
      <TotalValue label="Aportes" value={summary.investmentCents} currency={currency}/>
      <TotalValue label="Resultado" value={summary.incomeCents - summary.expenseCents} currency={currency}/>
      <TotalValue label="A receber" value={scheduledReceivablesCents} currency={currency}/>
    </div>
    <div className="mt-4 grid gap-2 border-t border-[var(--border)] pt-3 sm:grid-cols-3">
      <TotalFinancialMetric label="Saldo disponível" value={availableBalanceCents} currency={currency}/>
      <TotalFinancialMetric label="Compromissos do mês" value={committedCents} currency={currency} negative/>
      <TotalFinancialMetric label="Disponível para gastar" value={freeToSpendCents} currency={currency} accent help="Saldo disponível menos contas recorrentes ainda pendentes neste mês."/>
    </div>
  </AnimatedCard></section>;
}
function currentCash(data: BusinessInstitutionData, transactions: FinanceTransaction[]) {
  const accounts = (data.institutions || []).flatMap((institution) => institution.accounts.map((account) => ({
    name: `${institution.name} • ${account.name}`, balance: account.balance,
  })));
  if (!accounts.length) return null;
  return accounts.reduce((total, account) => total + accountBalance(account.balance, account.name, transactions), 0);
}

export function BusinessFinanceDashboard({
  workspaceId, month, data, allTransactions, summary, total, availableBalanceCents, committedCents,
  freeToSpendCents, scheduledReceivablesCents = 0, latePayables = 0, lateReceivables = 0, onCriticalReady, go,
}: {
  workspaceId: string; month: Date; data: BusinessInstitutionData;
  allTransactions: FinanceTransaction[]; summary: DashboardTotals; total: DashboardTotals;
  availableBalanceCents: number; committedCents: number; freeToSpendCents: number;
  scheduledReceivablesCents?: number; latePayables?: number; lateReceivables?: number; onCriticalReady?: () => void;
  go: (view: "planning" | "result" | "cashflow" | "receivables" | "payables") => void;
}) {
  const period = monthKey(month);
  const year = new Date().getFullYear();
  const [assumptions, setAssumptions] = useState<AssumptionRecord>({});
  const [planGoals, setPlanGoals] = useState<Partial<Record<BusinessPlanGoalKey, BusinessPlanGoal | null>>>({});
  const [profile, setProfile] = useState<Profile>(blankProfile);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [requestRevision, setRequestRevision] = useState(0);
  useEffect(() => {
    let stale = false;
    setLoading(true); setError("");
    void authorizedRequest(workspaceId, `/api/workspaces/business/profile?month=${encodeURIComponent(period)}`)
      .then((result) => {
        if (stale) return;
        setAssumptions(result.assumptions || {});
        setPlanGoals(result.planGoals || {});
        setProfile({ ...blankProfile, ...result.profile });
        setLoading(false);
        onCriticalReady?.();
      }).catch((cause) => {
        if (stale) return;
        setError(cause instanceof Error && cause.name === "TimeoutError" ? "A consulta do perfil empresarial demorou mais que o esperado." : cause instanceof Error ? cause.message : "Não foi possível carregar o perfil empresarial.");
        setLoading(false);
        onCriticalReady?.();
      });
    return () => { stale = true; };
  }, [workspaceId, period, requestRevision, onCriticalReady]);
  const snapshot = useMemo(() => {
    const values = Object.values(assumptions).filter((item): item is BusinessAssumption => Boolean(item));
    return calculateBusinessFinanceSnapshot({
      period, transactions: allTransactions, assumptions: values,
      cashAvailableCents: currentCash(data, allTransactions),
    });
  }, [allTransactions, assumptions, data, period]);
  const cashEvents = useMemo(() => buildBusinessCashEvents({
    receivables: data.plannedReceivables || [],
    payables: data.recurringBills || [],
    transactions: allTransactions,
    days: 90,
  }), [allTransactions, data.plannedReceivables, data.recurringBills]);
  const forecastCash30Days = projectedBusinessCash(availableBalanceCents, cashEvents, 30);
  const totalCard = <BusinessTotalCard summary={summary} total={total} availableBalanceCents={availableBalanceCents} committedCents={committedCents} freeToSpendCents={freeToSpendCents} scheduledReceivablesCents={scheduledReceivablesCents} currency={profile.default_currency}/>;
  if (loading) return <>{totalCard}<section aria-label="Resumo empresarial" className="panel mt-5 rounded-3xl p-5 sm:p-6"><p className="muted text-sm">Carregando indicadores empresariais…</p></section></>;
  const annualGoal = planGoals.annual_revenue_goal?.amountCents ?? null;
  const annual = calculateAnnualRevenueOutlook(year, allTransactions, annualGoal);
  const statusCards = [
    { label: "Caixa disponível", value: formatBusinessMoney(availableBalanceCents, profile.default_currency), detail: "Saldo atual nas contas", action: "cashflow" as const },
    { label: "A receber", value: formatBusinessMoney(scheduledReceivablesCents, profile.default_currency), detail: "Previsto no mês selecionado", action: "receivables" as const },
    { label: "A pagar", value: formatBusinessMoney(committedCents, profile.default_currency), detail: "Compromissos previstos no mês", action: "payables" as const },
    { label: "Resultado", value: formatBusinessMoney(summary.incomeCents - summary.expenseCents, profile.default_currency), detail: "Receitas menos despesas registradas", action: "result" as const },
  ];
  const dueAttention = (latePayables || 0) + (lateReceivables || 0);
  return <>{totalCard}<section aria-label="Resumo empresarial" className="panel mt-5 rounded-3xl p-4 sm:p-6">
    <header className="flex flex-wrap items-start justify-between gap-3"><div><div className="flex items-center gap-2"><Building2 size={17} className="text-[var(--accent)]"/><h2 className="text-lg font-semibold">Visão da empresa</h2></div><p className="muted mt-1 text-xs">Indicadores do período · visão de caixa</p></div><button type="button" onClick={() => go("planning")} className="min-h-10 rounded-xl bg-[var(--panel2)] px-3 text-xs font-medium text-[var(--accent)]">Metas e planejamento</button></header>
    {error && <div role="alert" className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-400/30 bg-amber-400/10 p-3 text-xs leading-5 text-amber-100"><span>Não foi possível atualizar as premissas empresariais. Os valores registrados continuam disponíveis.</span><button type="button" onClick={() => setRequestRevision((value) => value + 1)} className="min-h-9 rounded-lg bg-[var(--panel2)] px-3 font-medium">Tentar novamente</button></div>}
    <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {statusCards.map((card) => <button type="button" key={card.label} onClick={() => go(card.action)} className="min-w-0 rounded-2xl border border-[var(--border)] bg-[var(--panel2)]/70 p-4 text-left transition-colors hover:border-[var(--accent)]/50"><span className="muted block text-xs">{card.label}</span><b className="mt-2 block truncate text-xl tracking-tight" title={card.value}>{card.value}</b><small className="muted mt-1 block truncate text-[11px]">{card.detail}</small></button>)}
    </div>
    <section className="mt-4 rounded-2xl border border-[var(--border)] p-4 sm:p-5" aria-label={`Faturamento anual ${year}`}>
      <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="muted text-[11px] font-semibold uppercase tracking-[.12em]">Faturamento · {year}</p><h3 className="mt-1 text-base font-semibold">Realizado e perspectiva anual</h3></div><button type="button" onClick={() => go("result")} className="min-h-10 rounded-xl bg-[var(--panel2)] px-3 text-xs font-medium text-[var(--accent)]">Ver resultado</button></div>
      <div className="mt-4 grid gap-4 sm:grid-cols-3"><TotalValue label="Realizado no ano" value={annual.actualCents} currency={profile.default_currency}/><div className="min-w-0"><p className="muted text-xs">Projeção anual estimada</p><b className="mt-1 block text-base font-semibold" title={annual.explanation}>{annual.forecastCents === null ? "Dados insuficientes" : formatBusinessMoney(annual.forecastCents, profile.default_currency)}</b>{annual.forecastCents === null && <small className="muted block text-[11px]">{annual.explanation}</small>}</div><div className="min-w-0"><p className="muted text-xs">Meta anual</p><b className="mt-1 block text-base font-semibold">{annual.goalCents === null ? "Não definida" : formatBusinessMoney(annual.goalCents, profile.default_currency)}</b>{annual.progressPercent !== null && <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--panel2)]"><span className="block h-full rounded-full bg-[var(--accent)]" style={{ width: `${Math.min(100, Math.max(0, annual.progressPercent))}%` }}/></div>}</div></div>
    </section>
    <div className="mt-4 grid gap-3 lg:grid-cols-2">
      <section className="rounded-2xl border border-[var(--border)] p-4"><div className="flex items-start justify-between gap-3"><div><h3 className="text-sm font-semibold">Resultado gerencial</h3><p className="muted mt-1 text-xs">Não substitui uma demonstração contábil ou fiscal.</p></div><button type="button" onClick={() => go("result")} className="min-h-9 rounded-lg px-2 text-xs font-medium text-[var(--accent)]">Detalhes</button></div><div className="mt-3 flex items-end justify-between gap-3"><span className="muted text-xs">Margem bruta</span><b className="text-lg">{snapshot.grossMarginPercent === null ? "—" : `${snapshot.grossMarginPercent.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`}</b></div></section>
      <section className="rounded-2xl border border-[var(--border)] p-4"><div className="flex items-start justify-between gap-3"><div><h3 className="text-sm font-semibold">Fluxo de caixa</h3><p className="muted mt-1 text-xs">Estimativa com recebimentos e pagamentos programados · 30 dias.</p></div><button type="button" onClick={() => go("cashflow")} className="min-h-9 rounded-lg px-2 text-xs font-medium text-[var(--accent)]">Ver fluxo</button></div><b className="mt-3 block text-lg">{formatBusinessMoney(forecastCash30Days, profile.default_currency)}</b></section>
    </div>
    <section className={`mt-4 rounded-2xl border p-4 ${dueAttention ? "border-amber-400/30 bg-amber-400/5" : "border-[var(--border)]"}`}><h3 className="text-sm font-semibold">Atenção</h3>{dueAttention ? <p className="muted mt-1 text-xs">Há {latePayables || 0} conta(s) a pagar e {lateReceivables || 0} recebimento(s) em atraso. <button type="button" onClick={() => go(latePayables ? "payables" : "receivables")} className="font-medium text-[var(--accent)]">Revisar agora</button></p> : <p className="muted mt-1 text-xs">Nenhum compromisso vencido identificado no período atual.</p>}</section>
    <footer className="muted mt-4 flex flex-wrap items-center gap-2 border-t border-[var(--border)] pt-3 text-[10px]"><span className="inline-flex items-center gap-1"><Info size={12}/> Projeções são estimativas, não garantias.</span><HelpHint label="O que significa a projeção?"><p>O faturamento realizado soma somente entradas categorizadas como receita no ano. A projeção só aparece com pelo menos três meses com faturamento e usa a média mensal observada anualizada. Transferências, aportes e aplicações não entram.</p></HelpHint></footer>
  </section></>;
}

export function BusinessFinanceDetail({ workspaceId, month, data, allTransactions, cashBalanceCents, mode }: {
  workspaceId: string; month: Date; data: BusinessInstitutionData; allTransactions: FinanceTransaction[];
  cashBalanceCents: number; mode: "result" | "cashflow";
}) {
  const period = monthKey(month);
  const [assumptions, setAssumptions] = useState<AssumptionRecord>({});
  const [profile, setProfile] = useState<Profile>(blankProfile);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    let stale = false;
    setLoading(true); setError("");
    void authorizedRequest(workspaceId, `/api/workspaces/business/profile?month=${encodeURIComponent(period)}`)
      .then((result) => {
        if (stale) return;
        setAssumptions(result.assumptions || {});
        setProfile({ ...blankProfile, ...result.profile });
        setLoading(false);
      }).catch(() => {
        if (stale) return;
        setError("Não foi possível atualizar as premissas empresariais. Os dados registrados continuam disponíveis.");
        setLoading(false);
      });
    return () => { stale = true; };
  }, [workspaceId, period]);
  const snapshot = useMemo(() => calculateBusinessFinanceSnapshot({
    period,
    transactions: allTransactions,
    assumptions: Object.values(assumptions).filter((item): item is BusinessAssumption => Boolean(item)),
    cashAvailableCents: cashBalanceCents,
  }), [allTransactions, assumptions, cashBalanceCents, period]);
  const events = useMemo(() => buildBusinessCashEvents({
    receivables: data.plannedReceivables || [],
    payables: data.recurringBills || [],
    transactions: allTransactions,
    days: 90,
  }), [allTransactions, data.plannedReceivables, data.recurringBills]);
  if (loading) return <section className="mx-auto max-w-5xl px-4 pt-8"><div className="panel rounded-2xl p-5"><p className="muted text-sm">Carregando {mode === "result" ? "resultado" : "fluxo de caixa"}…</p></div></section>;
  return <section className="mx-auto max-w-5xl px-4 pt-8 lg:px-10">
    <header><p className="muted text-xs">Gestão financeira · {period}</p><h2 className="mt-1 text-2xl font-semibold tracking-tight">{mode === "result" ? "Resultado gerencial" : "Fluxo de caixa"}</h2><p className="muted mt-2 text-sm">{mode === "result" ? "Visão gerencial do período; não é uma demonstração contábil ou fiscal." : "Caixa realizado separado dos recebimentos e compromissos futuros."}</p></header>
    {error && <p role="alert" className="mt-4 rounded-xl border border-amber-400/30 bg-amber-400/10 p-3 text-sm text-amber-100">{error}</p>}
    {mode === "result" ? <>
      <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><Metric label="Faturamento realizado" item={snapshot.grossRevenue} currency={profile.default_currency}/><Metric label="Despesas registradas" item={snapshot.registeredExpenses} currency={profile.default_currency}/><Metric label="Resultado gerencial" item={snapshot.managerialResult} currency={profile.default_currency}/><PercentageMetric label="Margem bruta" percent={snapshot.grossMarginPercent} nature={snapshot.grossResultDre.nature} explanation="Resultado bruto gerencial dividido pela receita líquida. Só aparece quando as linhas necessárias estão preenchidas."/></div>
      <section className="panel mt-4 rounded-2xl p-5"><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">DRE gerencial simplificada</h3><span className="muted text-[11px]">Valores informados e cálculos gerenciais</span></div><div className="mt-4 space-y-3 text-sm"><DreRow label="Receita bruta" item={snapshot.grossDre} currency={profile.default_currency}/><DreRow label="(−) Impostos provisionados" item={snapshot.taxesDre} currency={profile.default_currency}/><DreRow label="Receita líquida" item={snapshot.netRevenueDre} currency={profile.default_currency} strong/><DreRow label="(−) Custos diretos" item={snapshot.directCostsDre} currency={profile.default_currency}/><DreRow label="Resultado bruto" item={snapshot.grossResultDre} currency={profile.default_currency} strong/><DreRow label="(−) Despesas operacionais" item={snapshot.operatingExpensesDre} currency={profile.default_currency}/><DreRow label="Resultado operacional" item={snapshot.operatingResultDre} currency={profile.default_currency} strong/><DreRow label="Resultado gerencial" item={snapshot.managerialResult} currency={profile.default_currency} strong/></div><p className="muted mt-4 text-xs leading-5">Entradas, despesas e premissas são identificadas pela origem. Transferências, aportes e aplicações não representam faturamento operacional.</p></section>
    </> : <>
      <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><section className="panel rounded-2xl p-4"><p className="muted text-xs">Caixa atual</p><b className="mt-2 block text-xl">{formatBusinessMoney(cashBalanceCents, profile.default_currency)}</b></section>{[30, 60, 90].map((days) => <section className="panel rounded-2xl p-4" key={days}><p className="muted text-xs">Caixa projetado · {days} dias</p><b className="mt-2 block text-xl">{formatBusinessMoney(projectedBusinessCash(cashBalanceCents, events, days), profile.default_currency)}</b></section>)}</div>
      <section className="panel mt-4 rounded-2xl p-5"><div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="font-semibold">Próximos compromissos</h3><p className="muted mt-1 text-xs">Projeção simples em regime de caixa, com recebíveis e contas programadas.</p></div><span className="rounded-full bg-[var(--panel2)] px-2.5 py-1 text-[11px]">{events.length} eventos</span></div>{events.length ? <div className="mt-3 divide-y divide-[var(--border)]">{events.slice(0, 30).map((event) => <div key={event.id} className="flex items-center justify-between gap-3 py-3"><span className="min-w-0"><b className="block truncate text-sm">{event.label}</b><small className="muted">{new Intl.DateTimeFormat("pt-BR").format(new Date(`${event.date}T12:00:00`))} · {event.kind === "receivable" ? "A receber" : "A pagar"}</small></span><b className={`shrink-0 text-sm ${event.kind === "receivable" ? "text-[var(--accent)]" : "text-amber-300"}`}>{event.kind === "receivable" ? "+" : "−"}{formatBusinessMoney(event.amountCents, profile.default_currency)}</b></div>)}</div> : <p className="muted mt-4 text-sm">Sem recebimentos ou compromissos programados para os próximos 90 dias.</p>}<p className="muted mt-4 border-t border-[var(--border)] pt-3 text-xs leading-5">A projeção considera somente eventos programados e não conta transferências como entrada ou saída consolidada. Valores futuros podem mudar.</p></section>
    </>}
  </section>;
}

function DreRow({ label, item, currency, strong = false }: { label: string; item: { amountCents: number | null; nature: FinancialDataNature | null }; currency: string; strong?: boolean }) {
  const exactAmount = exactMonthlyMoney(item.amountCents, currency);
  return <div className={`flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border)]/60 pb-2 ${strong ? "font-semibold" : ""}`}><span>{label}</span><span className="inline-flex items-center gap-2 text-right">{natureBadge(item.nature)}<span aria-label={exactAmount} title={item.amountCents === null ? undefined : exactAmount} className="min-w-28">{displayMonthlyMoney(item.amountCents, currency)}</span></span></div>;
}
function PercentageMetric({ label, percent, nature, explanation }: { label: string; percent: number | null; nature: FinancialDataNature | null; explanation: string }) {
  const tone = natureTone(nature);
  return <article data-nature={nature || "none"} className={`min-w-0 rounded-2xl p-4 ${styles.metricCard} ${tone}`} title={explanation}>
    <h3 className="min-h-10 text-sm font-semibold leading-5 text-[var(--fg)]">{label}</h3>
    <p data-metric-value className={`mt-1 font-semibold tracking-tight ${percent === null ? "break-words text-base leading-tight sm:text-lg" : "whitespace-nowrap text-lg tabular-nums sm:text-xl 2xl:text-2xl"}`}>{percent === null ? "Sem dados" : `${percent.toLocaleString("pt-BR", { maximumFractionDigits: 2 })}%`}</p>
    <div className="mt-2 flex min-w-0 items-center justify-between gap-2"><details className="muted min-w-0 text-[11px]"><summary className="inline-flex cursor-pointer list-none items-center gap-1"><Info size={12}/> Como calculamos?</summary><p className="mt-1 leading-5">{explanation}</p></details>{natureBadge(nature)}</div>
  </article>;
}
function FlowRow({ label, amount, icon, currency }: { label: string; amount: number | null; icon: "neutral" | "in" | "out"; currency: string }) {
  const Icon = icon === "in" ? ArrowDownLeft : icon === "out" ? ArrowUpRight : null;
  const exactAmount = exactMonthlyMoney(amount, currency);
  return <div className="flex items-center justify-between gap-3"><span className="muted flex min-w-0 items-center gap-2">{Icon && <Icon size={14} className={icon === "in" ? "text-[var(--accent)]" : "text-amber-300"}/>}<span>{label}</span></span><b aria-label={exactAmount} title={amount === null ? undefined : exactAmount} className="shrink-0">{displayMonthlyMoney(amount, currency)}</b></div>;
}

export function BusinessFinanceSettings({ workspaceId, toast, section = "settings" }: { workspaceId: string; toast: (message: string) => void; section?: "settings" | "planning" }) {
  const [referenceMonth, setReferenceMonth] = useState(() => monthKey(new Date()));
  const [referenceYear, setReferenceYear] = useState(() => String(new Date().getFullYear()));
  const [profile, setProfile] = useState<Profile>(blankProfile);
  const [assumptions, setAssumptions] = useState<AssumptionRecord>({});
  const [planGoals, setPlanGoals] = useState<PlanGoalRecord>({});
  const [planInputs, setPlanInputs] = useState<Record<BusinessPlanGoalKey, string>>(() => Object.fromEntries(BUSINESS_PLAN_GOAL_KEYS.map((key) => [key, ""])) as Record<BusinessPlanGoalKey, string>);
  const [amountInputs, setAmountInputs] = useState<Record<BusinessAssumptionKey, string>>(() => Object.fromEntries(BUSINESS_ASSUMPTION_KEYS.map((key) => [key, ""])) as Record<BusinessAssumptionKey, string>);
  const [natures, setNatures] = useState<Record<BusinessAssumptionKey, "reported" | "estimated">>(() => Object.fromEntries(BUSINESS_ASSUMPTION_KEYS.map((key) => [key, "estimated"])) as Record<BusinessAssumptionKey, "reported" | "estimated">);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<"company" | "finance" | "plan" | "">("");
  const [error, setError] = useState("");
  const [loadedProfile, setLoadedProfile] = useState(false);

  useEffect(() => {
    let stale = false;
    setLoading(true); setError("");
    void authorizedRequest(workspaceId, `/api/workspaces/business/profile?month=${encodeURIComponent(referenceMonth)}`)
      .then((result) => {
        if (stale) return;
        const nextProfile = { ...blankProfile, ...result.profile } as Profile;
        const nextAssumptions = (result.assumptions || {}) as AssumptionRecord;
        setProfile(nextProfile);
        setAssumptions(nextAssumptions);
        const nextGoals = (result.planGoals || {}) as PlanGoalRecord;
        setPlanGoals(nextGoals);
        setPlanInputs(Object.fromEntries(BUSINESS_PLAN_GOAL_KEYS.map((key) => [key, centsInput(nextGoals[key]?.amountCents)])) as Record<BusinessPlanGoalKey, string>);
        setAmountInputs(Object.fromEntries(BUSINESS_ASSUMPTION_KEYS.map((key) => [key, centsInput(nextAssumptions[key]?.amountCents)])) as Record<BusinessAssumptionKey, string>);
        setNatures(Object.fromEntries(BUSINESS_ASSUMPTION_KEYS.map((key) => [key, nextAssumptions[key]?.nature || "estimated"])) as Record<BusinessAssumptionKey, "reported" | "estimated">);
        setLoadedProfile(true); setLoading(false);
      }).catch((cause) => {
        if (stale) return;
        setError(cause instanceof Error ? cause.message : "Não foi possível carregar os dados empresariais.");
        setLoading(false);
      });
    return () => { stale = true; };
  }, [workspaceId, referenceMonth, referenceYear, section]);

  const saveCompany = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setSaving("company"); setError("");
    try {
      await authorizedRequest(workspaceId, "/api/workspaces/business/profile", {
        method: "PATCH", body: JSON.stringify({ section: "company", profile: {
          email: profile.email || "", phone: profile.phone || "", postal_code: profile.postal_code || "",
          street: profile.street || "", number: profile.number || "", address_complement: profile.address_complement || "",
          neighborhood: profile.neighborhood || "", city: profile.city || "", state: profile.state || "",
          activity_start_date: profile.activity_start_date || "", cnae: profile.cnae || "", tax_regime: profile.tax_regime,
          accountant_name: profile.accountant_name || "", management_close_day: profile.management_close_day,
          default_currency: profile.default_currency || "BRL", timezone: profile.timezone || "America/Sao_Paulo",
        } }),
      });
      toast("Dados cadastrais da empresa atualizados.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível salvar o cadastro da empresa."); }
    finally { setSaving(""); }
  };

  const saveFinance = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setSaving("finance"); setError("");
    const financialValues = BUSINESS_ASSUMPTION_KEYS.map((metricKey) => {
      const amountCents = parseBusinessMoneyToCents(amountInputs[metricKey]);
      return { metricKey, amountCents, nature: natures[metricKey] };
    });
    if (financialValues.some((item, index) => amountInputs[BUSINESS_ASSUMPTION_KEYS[index]].trim() && item.amountCents === null)) {
      setSaving(""); return setError("Confira os valores monetários. Use, por exemplo, 12.500,00.");
    }
    try {
      await authorizedRequest(workspaceId, "/api/workspaces/business/profile", {
        method: "PATCH", body: JSON.stringify({ section: "finance", referenceMonth, requestId: crypto.randomUUID(), assumptions: financialValues }),
      });
      toast("Perfil financeiro salvo com histórico e origem dos valores.");
      const result = await authorizedRequest(workspaceId, `/api/workspaces/business/profile?month=${encodeURIComponent(referenceMonth)}`);
      setAssumptions(result.assumptions || {});
      setAmountInputs(Object.fromEntries(BUSINESS_ASSUMPTION_KEYS.map((key) => [key, centsInput(result.assumptions?.[key]?.amountCents)])) as Record<BusinessAssumptionKey, string>);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível salvar as estimativas."); }
    finally { setSaving(""); }
  };

  const savePlan = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setSaving("plan"); setError("");
    const goals = BUSINESS_PLAN_GOAL_KEYS.map((metricKey) => ({ metricKey, amountCents: parseBusinessMoneyToCents(planInputs[metricKey]) }));
    if (goals.some((item) => planInputs[item.metricKey].trim() && item.amountCents === null)) {
      setSaving(""); return setError("Confira os valores das metas. Use, por exemplo, 250.000,00.");
    }
    try {
      await authorizedRequest(workspaceId, "/api/workspaces/business/profile", {
        method: "PATCH", body: JSON.stringify({ section: "plan", referenceYear, requestId: crypto.randomUUID(), goals }),
      });
      toast("Metas e limites do planejamento salvos para este ano.");
      const result = await authorizedRequest(workspaceId, `/api/workspaces/business/profile?month=${encodeURIComponent(`${referenceYear}-12`)}`);
      setPlanGoals(result.planGoals || {});
      setPlanInputs(Object.fromEntries(BUSINESS_PLAN_GOAL_KEYS.map((key) => [key, centsInput(result.planGoals?.[key]?.amountCents)])) as Record<BusinessPlanGoalKey, string>);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível salvar o planejamento."); }
    finally { setSaving(""); }
  };

  const updateProfile = (key: keyof Profile, value: string | number | null) => setProfile((current) => ({ ...current, [key]: value }));
  if (loading) return <section className="panel mt-5 rounded-2xl p-5"><p className="muted text-sm">Carregando o perfil da empresa…</p></section>;

  return <section className="mx-auto max-w-5xl px-4 pt-8 lg:px-10">
    <header><p className="muted text-xs">{section === "planning" ? "Gestão · Planejamento" : "Sistema · Empresa"}</p><div className="mt-1 flex flex-wrap items-center gap-2"><h2 className="text-2xl font-semibold tracking-tight">{section === "planning" ? "Planejamento financeiro" : "Configurações da empresa"}</h2><HelpHint label={section === "planning" ? "Metas e referências" : "Perfil da empresa"}><p>{section === "planning" ? "Defina metas estratégicas e referências gerenciais. Os resultados realizados continuam sendo calculados a partir das movimentações." : "Atualize as informações cadastrais e preferências financeiras da empresa."}</p></HelpHint></div><p className="muted mt-2 max-w-2xl text-sm">{section === "planning" ? "Metas anuais, caixa mínimo e referências de faturamento, custos e despesas." : "Dados cadastrais e preferências do espaço empresarial."}</p></header>
    {error && <p role="alert" className="mt-4 rounded-xl border border-[var(--danger)]/35 bg-[var(--danger)]/10 p-3 text-sm leading-5 text-[var(--danger)]">{error}</p>}
    {section === "settings" && <section className="panel mt-5 rounded-2xl p-4 sm:p-5"><div className="flex items-start justify-between gap-3"><div><h3 className="font-semibold">Dados da empresa</h3><p className="muted mt-1 text-xs">Informações cadastrais e preferências financeiras.</p></div><span className="rounded-full bg-[var(--panel2)] px-2.5 py-1 text-[10px]">{profile.trade_name || "Empresa"}</span></div>
      <div className="muted mt-4 grid gap-3 rounded-xl bg-[var(--panel2)] p-3 text-xs sm:grid-cols-2"><p><span className="block opacity-70">Razão social</span><b className="mt-1 block text-[var(--fg)]">{profile.legal_name || "Não informada"}</b></p><p><span className="block opacity-70">CNPJ</span><b className="mt-1 block text-[var(--fg)]">{profile.cnpj || "Não informado"}</b></p></div>
      <form onSubmit={(event) => void saveCompany(event)} className="mt-4 grid gap-3 sm:grid-cols-2">
        <Field label="E-mail empresarial" value={profile.email || ""} onChange={(value) => updateProfile("email", value)} type="email"/>
        <Field label="Telefone" value={profile.phone || ""} onChange={(value) => updateProfile("phone", value)} type="tel"/>
        <Field label="Início das atividades" value={profile.activity_start_date || ""} onChange={(value) => updateProfile("activity_start_date", value || null)} type="date"/>
        <Field label="CNAE principal · 7 dígitos" value={profile.cnae || ""} onChange={(value) => updateProfile("cnae", value.replace(/\D/g, "").slice(0, 7) || null)} inputMode="numeric"/>
        <label className="block text-xs">Regime tributário<select className="field mt-1" value={profile.tax_regime || ""} onChange={(event) => updateProfile("tax_regime", event.target.value || null)}><option value="">Não informado</option><option value="mei">MEI</option><option value="simples_nacional">Simples Nacional</option><option value="lucro_presumido">Lucro presumido</option><option value="lucro_real">Lucro real</option><option value="other">Outro</option></select></label>
        <Field label="Contador / responsável" value={profile.accountant_name || ""} onChange={(value) => updateProfile("accountant_name", value || null)}/>
        <Field label="Dia de fechamento gerencial" value={profile.management_close_day?.toString() || ""} onChange={(value) => updateProfile("management_close_day", value ? Number(value) : null)} inputMode="numeric"/>
        <Field label="Moeda padrão" value={profile.default_currency || "BRL"} onChange={(value) => updateProfile("default_currency", value.toUpperCase().slice(0, 3) || "BRL")}/>
        <Field label="Fuso horário" value={profile.timezone || "America/Sao_Paulo"} onChange={(value) => updateProfile("timezone", value)}/>
        <Field label="CEP" value={profile.postal_code || ""} onChange={(value) => updateProfile("postal_code", value || null)}/>
        <Field label="Rua / avenida" value={profile.street || ""} onChange={(value) => updateProfile("street", value || null)}/>
        <Field label="Número" value={profile.number || ""} onChange={(value) => updateProfile("number", value || null)}/>
        <Field label="Complemento" value={profile.address_complement || ""} onChange={(value) => updateProfile("address_complement", value || null)}/>
        <Field label="Bairro" value={profile.neighborhood || ""} onChange={(value) => updateProfile("neighborhood", value || null)}/>
        <Field label="Cidade" value={profile.city || ""} onChange={(value) => updateProfile("city", value || null)}/>
        <Field label="UF" value={profile.state || ""} onChange={(value) => updateProfile("state", value.toUpperCase().slice(0, 2) || null)}/>
        <div className="flex justify-end pt-1 sm:col-span-2"><button type="submit" disabled={saving !== ""} className="primary inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl px-4 text-sm font-semibold disabled:opacity-60 sm:w-auto"><Save size={15}/>{saving === "company" ? "Salvando…" : "Salvar dados da empresa"}</button></div>
      </form>
    </section>}

    {section === "planning" && <>
    <section className="panel mt-5 rounded-2xl p-4 sm:p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="font-semibold">Metas estratégicas</h3><p className="muted mt-1 text-xs">Metas são valores desejados; o realizado é calculado pelas movimentações.</p></div><label className="block text-xs">Ano de referência<input aria-label="Ano de referência" type="number" inputMode="numeric" min="2000" max="9999" className="field mt-1 min-h-10 w-32" value={referenceYear} onChange={(event) => { const nextYear = event.target.value.slice(0, 4); setReferenceYear(nextYear); if (nextYear.length === 4) setReferenceMonth(`${nextYear}-12`); }}/></label></div>
      <form onSubmit={(event) => void savePlan(event)} className="mt-4 grid gap-3 sm:grid-cols-2">{BUSINESS_PLAN_GOAL_KEYS.map((goalKey) => <label key={goalKey} className="block min-w-0 text-xs font-medium">{planGoalLabels[goalKey]}<input className="field mt-1" inputMode="decimal" value={planInputs[goalKey]} onChange={(event) => setPlanInputs((current) => ({ ...current, [goalKey]: event.target.value }))} placeholder="Não definido"/><small className="muted mt-1 block font-normal">{planGoals[goalKey] ? `Atualizado em ${planGoals[goalKey]?.referenceMonth.slice(0, 7)}` : "Deixe em branco para não definir uma meta."}</small></label>)}<div className="flex justify-end pt-1 sm:col-span-2"><button type="submit" disabled={saving !== "" || referenceYear.length !== 4} className="primary inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl px-4 text-sm font-semibold disabled:opacity-60 sm:w-auto"><Save size={15}/>{saving === "plan" ? "Salvando…" : "Salvar metas"}</button></div></form>
    </section>
    <section className="panel mt-4 rounded-2xl p-4 sm:p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="font-semibold">Premissas financeiras</h3><p className="muted mt-1 text-xs">Referências não substituem movimentações realizadas.</p></div><label className="block text-xs">Vigência<input aria-label="Mês de referência" type="month" className="field mt-1 min-h-10" value={referenceMonth} onChange={(event) => setReferenceMonth(event.target.value)}/></label></div>
      <form onSubmit={(event) => void saveFinance(event)} className="mt-4 space-y-3">
        {BUSINESS_ASSUMPTION_KEYS.map((key) => <AssumptionField key={key} metricKey={key} value={amountInputs[key]} nature={natures[key]} existing={assumptions[key] || null} onValue={(value) => setAmountInputs((current) => ({ ...current, [key]: value }))} onNature={(nature) => setNatures((current) => ({ ...current, [key]: nature }))}/>)}
        <div className="flex items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--panel2)]/65 p-3 text-xs"><p className="font-medium">Como esses valores são usados</p><HelpHint label="Uso dos valores empresariais"><p>O faturamento e as despesas do período vêm dos lançamentos quando existirem. Valores manuais permanecem como referências históricas; estimativas não apagam nem alteram o extrato. DRE e projeções são gerenciais e não fazem apuração fiscal.</p></HelpHint></div>
        <div className="flex justify-end pt-1"><button type="submit" disabled={saving !== ""} className="primary inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl px-4 text-sm font-semibold disabled:opacity-60 sm:w-auto"><Save size={15}/>{saving === "finance" ? "Salvando…" : "Salvar perfil financeiro"}</button></div>
      </form>
      {loadedProfile && <p className="muted mt-3 text-[10px]">As alterações ficam vinculadas a este workspace empresarial e mantêm o histórico de valores informado.</p>}
    </section></>}
  </section>;
}

function Field({ label, value, onChange, type = "text", inputMode }: { label: string; value: string; onChange: (value: string) => void; type?: string; inputMode?: "text" | "numeric" | "tel" }) {
  return <label className="block text-xs">{label}<input className="field mt-1" value={value} onChange={(event) => onChange(event.target.value)} type={type} inputMode={inputMode} maxLength={type === "email" ? 254 : 160}/></label>;
}
function AssumptionField({ metricKey, value, nature, existing, onValue, onNature }: {
  metricKey: BusinessAssumptionKey; value: string; nature: "reported" | "estimated"; existing: BusinessAssumption | null;
  onValue: (value: string) => void; onNature: (nature: "reported" | "estimated") => void;
}) {
  const estimateId = `business-${metricKey}-estimated`;
  const reportedId = `business-${metricKey}-reported`;
  return <div className="grid min-w-0 gap-3 rounded-xl border border-[var(--border)] p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] sm:items-center">
    <label htmlFor={`business-${metricKey}-amount`} className="min-w-0 text-xs font-medium">{assumptionLabels[metricKey]}<input id={`business-${metricKey}-amount`} className="field mt-1" inputMode="decimal" value={value} onChange={(event) => onValue(event.target.value)} placeholder="Não informado" aria-describedby={`business-${metricKey}-context`}/><small id={`business-${metricKey}-context`} className="muted mt-1 block font-normal">{existing ? `${natureLabels[existing.nature]} · referência desde ${existing.referenceMonth.slice(0, 7)}` : "Você pode deixar em branco e preencher depois."}</small></label>
    <fieldset className="flex flex-wrap gap-2 text-xs"><legend className="sr-only">Natureza de {assumptionLabels[metricKey]}</legend><label htmlFor={reportedId} className={`inline-flex min-h-10 cursor-pointer items-center gap-2 rounded-xl px-3 ${nature === "reported" ? "bg-[var(--accent)]/15 text-[var(--accent)]" : "bg-[var(--panel2)]"}`}><input id={reportedId} type="radio" name={`nature-${metricKey}`} checked={nature === "reported"} onChange={() => onNature("reported")} className="accent-[var(--accent)]"/>Valor exato informado</label><label htmlFor={estimateId} className={`inline-flex min-h-10 cursor-pointer items-center gap-2 rounded-xl px-3 ${nature === "estimated" ? "bg-[var(--accent)]/15 text-[var(--accent)]" : "bg-[var(--panel2)]"}`}><input id={estimateId} type="radio" name={`nature-${metricKey}`} checked={nature === "estimated"} onChange={() => onNature("estimated")} className="accent-[var(--accent)]"/>Valor aproximado</label></fieldset>
  </div>;
}
