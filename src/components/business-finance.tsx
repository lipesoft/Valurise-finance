"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { AlertTriangle, ArrowDownLeft, ArrowRight, ArrowUpRight, Building2, CalendarDays, Check, ChevronDown, Info, Save } from "lucide-react";
import { MoneyInput } from "@/components/numeric-inputs";
import { accountBalance, formatBRL, type FinanceTransaction } from "@/lib/finance";
import { HelpHint } from "@/components/help-hint";
import { AnimatedCard } from "@/components/motion";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { isRecurringBillPaidInMonth, isRecurringBillScheduledInMonth, recurringBillDueDay } from "@/lib/recurring-bills";
import styles from "@/components/business-finance.module.css";
import {
  BUSINESS_ASSUMPTION_KEYS,
  BUSINESS_PLAN_GOAL_KEYS,
  buildAnnualRevenueSeries,
  buildBusinessCashEvents,
  calculateAnnualRevenueOutlook,
  calculateBusinessFinanceSnapshot,
  calculateBusinessPeriodResult,
  formatBusinessMoney,
  parseBusinessMoneyToCents,
  type BusinessAssumption,
  type BusinessAssumptionKey,
  type BusinessCashEvent,
  type BusinessCashSchedule,
  type BusinessPlanGoal,
  type BusinessPlanGoalKey,
  type BusinessFinanceSnapshot,
  type FinancialDataNature,
  projectedBusinessCash,
} from "@/lib/business-finance";
import { getReceivableOccurrences, type PlannedReceivable } from "@/lib/receivables";
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

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

export function LegacyBusinessFinanceDashboard({
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

export function BusinessFinanceDashboard({ workspaceId, companyName, month, data, allTransactions, availableBalanceCents, onCriticalReady, go }: {
  workspaceId: string; companyName: string; month: Date; data: BusinessInstitutionData; allTransactions: FinanceTransaction[];
  availableBalanceCents: number; onCriticalReady?: () => void;
  go: (view: "planning" | "result" | "cashflow" | "receivables" | "payables" | "statement") => void;
}) {
  const period = monthKey(month);
  const currentYear = new Date().getFullYear();
  const [selectedYear, setSelectedYear] = useState(currentYear);
  const [yearMenuOpen, setYearMenuOpen] = useState(false);
  const yearPickerRef = useRef<HTMLButtonElement>(null);
  const yearPickerContainerRef = useRef<HTMLDivElement>(null);
  const [planGoals, setPlanGoals] = useState<Partial<Record<BusinessPlanGoalKey, BusinessPlanGoal | null>>>({});
  const [profile, setProfile] = useState<Profile>(blankProfile);
  const [loading, setLoading] = useState(true);
  const [loadedScope, setLoadedScope] = useState("");
  const [error, setError] = useState("");
  const [requestRevision, setRequestRevision] = useState(0);
  const profileMonth = selectedYear + "-12";
  const years = useMemo(() => {
    const available = new Set(allTransactions.filter((item) => item.type === "income").map((item) => Number(item.date.slice(0, 4))).filter((year) => year >= 2000 && year <= currentYear));
    available.add(currentYear);
    return [...available].sort((left, right) => right - left);
  }, [allTransactions, currentYear]);
  const dataScope = workspaceId + ":" + profileMonth;

  useEffect(() => { setSelectedYear(currentYear); }, [workspaceId, currentYear]);

  useEffect(() => {
    if (!yearMenuOpen) return;
    const dismissOnOutsideClick = (event: MouseEvent) => {
      if (event.target instanceof Node && !yearPickerContainerRef.current?.contains(event.target)) setYearMenuOpen(false);
    };
    document.addEventListener("mousedown", dismissOnOutsideClick);
    return () => document.removeEventListener("mousedown", dismissOnOutsideClick);
  }, [yearMenuOpen]);

  useEffect(() => {
    let stale = false;
    setLoading(true);
    setError("");
    setPlanGoals({});
    setProfile(blankProfile);
    void authorizedRequest(workspaceId, "/api/workspaces/business/profile?month=" + encodeURIComponent(profileMonth))
      .then((result) => {
        if (stale) return;
        setPlanGoals(result.planGoals || {});
        setProfile({ ...blankProfile, ...result.profile });
        setLoading(false);
        setLoadedScope(dataScope);
        onCriticalReady?.();
      })
      .catch((cause) => {
        if (stale) return;
        setError(cause instanceof Error ? cause.message : "Não foi possível carregar as metas empresariais.");
        setLoading(false);
        setLoadedScope(dataScope);
        onCriticalReady?.();
      });
    return () => { stale = true; };
  }, [workspaceId, profileMonth, requestRevision, onCriticalReady, dataScope]);

  const currency = profile.default_currency;
  const annualGoal = planGoals.annual_revenue_goal?.amountCents ?? null;
  const annualResultGoal = planGoals.annual_result_goal?.amountCents ?? null;
  const minimumCash = planGoals.minimum_cash?.amountCents ?? null;
  const expenseLimit = planGoals.expense_limit?.amountCents ?? null;
  const annual = useMemo(() => buildAnnualRevenueSeries(selectedYear, allTransactions, annualGoal), [allTransactions, annualGoal, selectedYear]);
  const periodResult = useMemo(() => calculateBusinessPeriodResult(period, allTransactions), [allTransactions, period]);
  const yearCutoff = selectedYear === currentYear
    ? String(selectedYear) + "-" + String(new Date().getMonth() + 1).padStart(2, "0") + "-" + String(new Date().getDate()).padStart(2, "0")
    : String(selectedYear) + "-12-31";
  const yearTransactions = allTransactions.filter((item) => item.date.startsWith(String(selectedYear) + "-") && item.date.slice(0, 10) <= yearCutoff);
  const yearExpenses = yearTransactions.filter((item) => item.type === "expense").reduce((sum, item) => sum + item.amountCents, 0);
  const yearResult = yearTransactions.filter((item) => item.type === "income").reduce((sum, item) => sum + item.amountCents, 0) - yearExpenses;
  const currentReceivables = useMemo(() => getReceivableOccurrences(data.plannedReceivables || [], period, allTransactions), [allTransactions, data.plannedReceivables, period]);
  const currentPayables = (data.recurringBills || []).filter((bill) => isRecurringBillScheduledInMonth(bill, period) && !isRecurringBillPaidInMonth(bill, period));
  const payableAmount = currentPayables.reduce((sum, bill) => sum + bill.amountCents, 0);
  const events = useMemo(() => buildBusinessCashEvents({
    receivables: data.plannedReceivables || [],
    payables: data.recurringBills || [],
    transactions: allTransactions,
    days: 90,
  }), [allTransactions, data.plannedReceivables, data.recurringBills]);
  const upcomingDate = new Date();
  upcomingDate.setDate(upcomingDate.getDate() + 7);
  const upcomingKey = upcomingDate.getFullYear() + "-" + String(upcomingDate.getMonth() + 1).padStart(2, "0") + "-" + String(upcomingDate.getDate()).padStart(2, "0");
  const upcomingEvents = events.filter((event) => event.date <= upcomingKey);
  const overdueReceivables = currentReceivables.filter((item) => item.status === "overdue");
  const today = new Date();
  const todayKey = today.getFullYear() + "-" + String(today.getMonth() + 1).padStart(2, "0") + "-" + String(today.getDate()).padStart(2, "0");
  const overduePayables = currentPayables.filter((bill) => period + "-" + String(recurringBillDueDay(bill, period)).padStart(2, "0") < todayKey);
  let projectedBalance = availableBalanceCents;
  let cashMinimumBreach: { date: string; balance: number } | null = minimumCash !== null && availableBalanceCents < minimumCash
    ? { date: todayKey, balance: availableBalanceCents }
    : null;
  const cashDeltasByDate = new Map<string, number>();
  for (const event of events) cashDeltasByDate.set(event.date, (cashDeltasByDate.get(event.date) || 0) + (event.kind === "receivable" ? event.amountCents : -event.amountCents));
  for (const [date, delta] of [...cashDeltasByDate.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    projectedBalance += delta;
    if (!cashMinimumBreach && minimumCash !== null && projectedBalance < minimumCash) cashMinimumBreach = { date, balance: projectedBalance };
  }
  const kpis = [
    { label: "Caixa disponível", amount: availableBalanceCents, detail: "Saldo consolidado nas contas", target: "cashflow" as const },
    { label: "A receber", amount: currentReceivables.filter((item) => item.status !== "received").reduce((sum, item) => sum + item.amountCents, 0), detail: "Em aberto neste mês", target: "receivables" as const },
    { label: "A pagar", amount: payableAmount, detail: "Compromissos não pagos no mês", target: "payables" as const },
    { label: "Resultado", amount: periodResult.resultCents, detail: "Receitas − despesas · " + period, target: "result" as const },
  ];
  const alerts: { title: string; detail?: string; target: "receivables" | "payables" | "cashflow" | "planning" }[] = [];
  if (overdueReceivables.length) alerts.push({ title: overdueReceivables.length + " recebimento(s) atrasado(s)", detail: formatBusinessMoney(overdueReceivables.reduce((sum, item) => sum + item.amountCents, 0), currency), target: "receivables" });
  if (overduePayables.length) alerts.push({ title: overduePayables.length + " conta(s) vencida(s)", detail: formatBusinessMoney(overduePayables.reduce((sum, item) => sum + item.amountCents, 0), currency), target: "payables" });
  for (const kind of ["receivable", "payable"] as const) {
    const rows = upcomingEvents.filter((event) => event.kind === kind);
    if (rows.length) alerts.push({ title: rows.length + (kind === "receivable" ? " recebimento(s)" : " conta(s)") + " nos próximos 7 dias", detail: formatBusinessMoney(rows.reduce((sum, item) => sum + item.amountCents, 0), currency), target: kind === "receivable" ? "receivables" : "payables" });
  }
  if (cashMinimumBreach) alerts.push({ title: "Caixa projetado abaixo do mínimo em " + new Intl.DateTimeFormat("pt-BR", { month: "long" }).format(new Date(cashMinimumBreach.date + "T12:00:00")), detail: "Saldo estimado: " + formatBusinessMoney(cashMinimumBreach.balance, currency), target: "cashflow" });
  if (annual.forecastCents !== null && annualGoal !== null && annualGoal > 0 && annual.forecastCents < annualGoal) {
    const gap = Math.round(((annualGoal - annual.forecastCents) / annualGoal) * 100);
    alerts.push({ title: "Projeção anual estimada " + gap + "% abaixo da meta", target: "planning" });
  }
  const expenseRatio = expenseLimit !== null && expenseLimit > 0 ? yearExpenses / expenseLimit : null;
  if (expenseRatio !== null && expenseRatio >= 0.8) alerts.push({ title: expenseRatio >= 1 ? "Despesas ultrapassaram o limite anual" : "Despesas próximas do limite anual", detail: Math.round(expenseRatio * 100) + "% do limite", target: "planning" });
  const recentMovements = [...allTransactions].sort((left, right) => right.date.localeCompare(left.date) || right.createdAt.localeCompare(left.createdAt)).slice(0, 5);

  if (loading || loadedScope !== dataScope) return <section aria-label="Visão geral empresarial" className="mt-5 space-y-4">
    <div className="flex items-end justify-between gap-3"><div><p className="muted text-xs">Visão geral</p><h1 className="text-2xl font-semibold tracking-tight">{companyName}</h1></div><span className="muted text-sm">Carregando…</span></div>
    <div className="panel rounded-2xl p-5"><p className="muted text-sm">Carregando indicadores empresariais…</p></div>
  </section>;

  return <section aria-label="Visão geral empresarial" className="mt-5 space-y-4">
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div><p className="muted text-xs">Visão geral</p><h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{companyName}</h1></div>
      <div ref={yearPickerContainerRef} className="relative" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setYearMenuOpen(false); }} onKeyDown={(event) => { if (event.key === "Escape") { setYearMenuOpen(false); yearPickerRef.current?.focus(); } }}>
        <button ref={yearPickerRef} type="button" aria-label="Ano do faturamento" aria-expanded={yearMenuOpen} aria-controls={yearMenuOpen ? "business-revenue-year-options" : undefined} onClick={() => setYearMenuOpen((open) => !open)} className="group inline-flex min-h-[52px] items-center gap-2.5 rounded-xl border border-[var(--border)] bg-[var(--panel2)] px-3 py-2.5 text-left transition-colors hover:border-[var(--accent)]/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]/60">
          <CalendarDays size={16} aria-hidden="true" className="shrink-0 text-[var(--accent)]"/>
          <span className="min-w-[76px]"><span className="muted block text-[9px] font-semibold uppercase leading-3 tracking-[.12em]">Faturamento</span><span className="mt-0.5 block text-sm font-semibold leading-4 tabular-nums text-[var(--fg)]">{selectedYear}</span></span>
          <ChevronDown size={14} aria-hidden="true" className={`shrink-0 text-[var(--muted)] transition-transform ${yearMenuOpen ? "rotate-180" : ""}`}/>
        </button>
        {yearMenuOpen && <div id="business-revenue-year-options" role="group" aria-label="Anos disponíveis" className="absolute right-0 z-30 mt-1 max-h-56 min-w-full overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--panel)] p-1 shadow-xl">
          {years.map((year) => <button type="button" key={year} aria-pressed={selectedYear === year} onClick={() => { setSelectedYear(year); setYearMenuOpen(false); yearPickerRef.current?.focus(); }} className={`flex min-h-10 w-full items-center justify-between gap-3 rounded-lg px-3 text-left text-sm tabular-nums transition-colors hover:bg-[var(--panel2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]/60 ${selectedYear === year ? "font-semibold text-[var(--accent)]" : "text-[var(--fg)]"}`}>
            {year}{selectedYear === year && <Check size={15} aria-hidden="true"/>}
          </button>)}
        </div>}
      </div>
    </header>
    {error && <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-400/30 bg-amber-400/10 p-3 text-xs leading-5 text-amber-100"><span>Não foi possível atualizar as metas empresariais. Os valores registrados continuam disponíveis.</span><button type="button" onClick={() => setRequestRevision((value) => value + 1)} className="min-h-9 rounded-lg bg-[var(--panel2)] px-3 font-medium">Tentar novamente</button></div>}
    <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
      {kpis.map((card) => <button type="button" key={card.label} onClick={() => go(card.target)} className="min-w-0 rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-3 text-left transition-colors hover:border-[var(--accent)]/50 sm:p-4">
        <span className="muted block text-xs">{card.label}</span>
        <b className={"mt-2 block truncate text-[clamp(1rem,2.2vw,1.35rem)] tracking-tight tabular-nums " + (card.label === "Resultado" ? card.amount < 0 ? "text-[var(--danger)]" : card.amount > 0 ? "text-[var(--accent)]" : "" : "")} title={exactMonthlyMoney(card.amount, currency)}>{formatBusinessMoney(card.amount, currency)}</b>
        <small className="muted mt-1 block truncate text-[10px] sm:text-[11px]">{card.detail}</small>
      </button>)}
    </div>
    <section className="panel rounded-2xl p-4 sm:p-5" aria-label={"Faturamento anual " + selectedYear}>
      <div className="flex flex-wrap items-start justify-between gap-4"><div><p className="muted text-[11px] font-semibold uppercase tracking-[.12em]">Faturamento anual · {selectedYear}</p><h2 className="mt-1 text-lg font-semibold">Realizado e projeção anual estimada</h2><div className="muted mt-1 inline-flex items-center gap-1 text-xs">Projeção linear baseada no histórico <HelpHint label="Como calculamos a projeção anual?"><p>{annual.explanation} A meta aparece como ritmo mensal (meta anual dividida por 12). Transferências, aportes, empréstimos e aplicações não são faturamento operacional.</p></HelpHint></div></div><button type="button" onClick={() => go("planning")} className="min-h-10 rounded-xl bg-[var(--panel2)] px-3 text-xs font-medium text-[var(--accent)]">Planejamento</button></div>
      <div className="mt-4 grid gap-3 rounded-xl bg-[var(--panel2)]/60 p-3 sm:grid-cols-3 sm:p-4">
        <div><p className="muted text-xs">Realizado</p><b className="mt-1 block text-base font-semibold tabular-nums">{formatBusinessMoney(annual.actualCents, currency)}</b></div>
        <div><p className="muted text-xs">Projeção anual estimada</p><b className="mt-1 block text-base font-semibold tabular-nums">{annual.forecastCents === null ? "Indisponível" : formatBusinessMoney(annual.forecastCents, currency)}</b>{annual.forecastCents === null && <small className="muted mt-1 block text-[10px]">Dados insuficientes para gerar uma projeção anual confiável.</small>}</div>
        <div><p className="muted text-xs">Meta anual</p><b className="mt-1 block text-base font-semibold tabular-nums">{annual.goalCents === null ? "Não definida" : formatBusinessMoney(annual.goalCents, currency)}</b></div>
      </div>
      {annual.hasActualData ? <div className="mt-4 h-[230px] w-full sm:h-[280px]" role="img" aria-label={"Gráfico de faturamento anual " + selectedYear}>
        <ResponsiveContainer width="100%" height="100%"><LineChart data={annual.points} margin={{ top: 10, right: 12, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false}/>
          <XAxis dataKey="label" tick={{ fill: "var(--muted)", fontSize: 11 }} tickLine={false} axisLine={false} interval={0}/>
          <YAxis width={42} tick={{ fill: "var(--muted)", fontSize: 10 }} tickLine={false} axisLine={false} tickFormatter={(value: number) => new Intl.NumberFormat("pt-BR", { notation: "compact", maximumFractionDigits: 1 }).format(value / 100)}/>
          <Tooltip labelFormatter={(label) => String(label) + " " + selectedYear} formatter={(value) => formatBusinessMoney(Number(value), currency)} contentStyle={{ background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 12, color: "var(--fg)" }}/>
          {annual.goalCents !== null && <ReferenceLine y={Math.round(annual.goalCents / 12)} stroke="#eab308" strokeDasharray="5 5" label={{ value: "Ritmo da meta", fill: "#eab308", fontSize: 10, position: "insideTopRight" }}/>}
          <Line name="Realizado" type="monotone" dataKey="actualCents" stroke="#4edea3" strokeWidth={2.5} dot={{ r: 2.5 }} activeDot={{ r: 5 }} connectNulls={false}/>
          {annual.forecastCents !== null && <Line name="Projeção" type="monotone" dataKey="projectionCents" stroke="#60a5fa" strokeWidth={2.5} strokeDasharray="7 5" dot={false} activeDot={{ r: 5 }} connectNulls={false}/>}
        </LineChart></ResponsiveContainer>
      </div> : <div className="mt-4 grid min-h-36 place-items-center rounded-xl border border-dashed border-[var(--border)] px-4 text-center"><p className="muted max-w-md text-sm">{annual.goalCents === null ? "Registre movimentações para acompanhar a evolução do faturamento." : "A meta anual está definida. Registre receitas operacionais para acompanhar o progresso."}</p></div>}
      {annual.goalCents !== null && annual.goalCents > 0 && <div className="mt-3 rounded-xl border border-[var(--border)] p-3">
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs"><b>Progresso da meta</b><span>{formatBusinessMoney(annual.actualCents, currency)} de {formatBusinessMoney(annual.goalCents, currency)} · {(annual.progressPercent || 0).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%</span></div>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-[var(--panel2)]" role="progressbar" aria-label="Progresso da meta anual de faturamento" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, Math.max(0, annual.progressPercent || 0))}><span className="block h-full rounded-full bg-[var(--accent)] transition-[width]" style={{ width: Math.min(100, Math.max(0, annual.progressPercent || 0)) + "%" }}/></div>
      </div>}
      <div className="muted mt-3 flex flex-wrap gap-4 text-[10px]"><span className="inline-flex items-center gap-1"><i className="h-0.5 w-4 rounded bg-emerald-400"/> Realizado</span>{annual.forecastCents !== null && <span className="inline-flex items-center gap-1"><i className="h-0.5 w-4 rounded border-t-2 border-dashed border-blue-400"/> Projeção</span>}{annual.goalCents !== null && <span className="inline-flex items-center gap-1"><i className="h-0.5 w-4 rounded border-t-2 border-dashed border-yellow-400"/> Ritmo mensal da meta anual</span>}</div>
    </section>
    <section className="panel rounded-2xl p-4 sm:p-5"><div className="mb-4 flex items-center justify-between gap-3"><div><h2 className="font-semibold">Indicadores de planejamento</h2><p className="muted mt-1 text-xs">Acompanhamento do ano selecionado, com limites definidos no Planejamento.</p></div><button type="button" onClick={() => go("planning")} className="min-h-9 rounded-lg px-2 text-xs font-medium text-[var(--accent)]">Editar metas</button></div><div className="grid gap-4 lg:grid-cols-3"><BusinessProgress label="Caixa mínimo" valueCents={availableBalanceCents} targetCents={minimumCash} currency={currency} kind="cash"/><BusinessProgress label="Despesas no ano" valueCents={yearExpenses} targetCents={expenseLimit} currency={currency} kind="limit"/><BusinessProgress label="Resultado no ano" valueCents={yearResult} targetCents={annualResultGoal} currency={currency} kind="goal"/></div></section>
    <section className={"rounded-2xl border p-4 sm:p-5 " + (alerts.length ? "border-amber-400/30 bg-amber-400/5" : "border-[var(--border)] bg-[var(--panel)]")}><div className="flex items-center gap-2"><AlertTriangle size={17} className={alerts.length ? "text-amber-300" : "text-[var(--accent)]"}/><h2 className="font-semibold">Atenção</h2></div>{alerts.length ? <ul className="mt-3 divide-y divide-[var(--border)]">{alerts.slice(0, 6).map((alert, index) => <li key={alert.title + index}><button type="button" onClick={() => go(alert.target)} className="flex min-h-12 w-full items-center justify-between gap-3 py-2 text-left hover:text-[var(--accent)]"><span className="min-w-0"><b className="block text-sm">{alert.title}</b>{alert.detail && <small className="muted mt-0.5 block text-xs">{alert.detail}</small>}</span><ArrowRight size={16} className="shrink-0"/></button></li>)}</ul> : <p className="muted mt-2 text-sm">Nenhum alerta financeiro identificado com as informações disponíveis.</p>}</section>
    <section className="panel rounded-2xl p-4 sm:p-5"><div className="flex items-center justify-between gap-3"><div><h2 className="font-semibold">Movimentações recentes</h2><p className="muted mt-1 text-xs">Últimos registros financeiros da empresa.</p></div><button type="button" onClick={() => go("statement")} className="min-h-10 shrink-0 rounded-xl bg-[var(--panel2)] px-3 text-xs font-medium text-[var(--accent)]">Ver todas</button></div>{recentMovements.length ? <div className="mt-2 divide-y divide-[var(--border)]">{recentMovements.map((item) => <div key={item.id} className="flex items-center justify-between gap-3 py-3"><span className="min-w-0"><b className="block truncate text-sm">{item.description?.trim() || item.category || (item.type === "income" ? "Receita" : item.type === "expense" ? "Despesa" : item.type === "investment" ? "Aplicação" : "Transferência")}</b><small className="muted block truncate">{new Intl.DateTimeFormat("pt-BR").format(new Date(item.date))} · {item.category}</small></span><b className={"shrink-0 text-sm tabular-nums " + (item.type === "income" ? "text-[var(--accent)]" : item.type === "expense" ? "text-[var(--danger)]" : "")}>{item.type === "income" ? "+" : item.type === "expense" ? "−" : ""}{formatBusinessMoney(item.amountCents, currency)}</b></div>)}</div> : <div className="grid min-h-28 place-items-center text-center"><p className="muted text-sm">Nenhuma movimentação registrada ainda.</p></div>}</section>
  </section>;
}

function BusinessProgress({ label, valueCents, targetCents, currency, kind }: { label: string; valueCents: number; targetCents: number | null; currency: string; kind: "cash" | "limit" | "goal" }) {
  const ratio = targetCents !== null && targetCents > 0 ? valueCents / targetCents : null;
  const status = ratio === null ? "Meta não definida" : kind === "cash" ? ratio < 1 ? "Abaixo do mínimo" : "Acima do mínimo" : kind === "limit" ? ratio >= 1 ? "Acima do limite" : ratio >= 0.8 ? "Próximo do limite" : "Dentro do esperado" : ratio >= 1 ? "Meta atingida" : "Em andamento";
  const tone = status.includes("Abaixo") || status.includes("Acima do limite") ? "text-[var(--danger)] bg-[var(--danger)]" : status.includes("limite") ? "text-amber-300 bg-amber-400" : "text-[var(--accent)] bg-[var(--accent)]";
  const width = ratio === null ? 0 : Math.min(100, Math.max(0, ratio * 100));
  return <article className="min-w-0 rounded-xl bg-[var(--panel2)]/50 p-3"><div className="flex items-center justify-between gap-2"><h3 className="text-sm font-medium">{label}</h3><span className={"shrink-0 rounded-full bg-[var(--panel2)] px-2 py-1 text-[10px] " + tone.split(" ")[0]}>{status}</span></div><p className="mt-2 truncate text-sm font-semibold tabular-nums" title={exactMonthlyMoney(valueCents, currency) + " de " + (targetCents === null ? "meta não definida" : exactMonthlyMoney(targetCents, currency))}>{formatBusinessMoney(valueCents, currency)} <span className="muted font-normal">/ {targetCents === null ? "—" : formatBusinessMoney(targetCents, currency)}</span></p><div className="mt-2 h-2 overflow-hidden rounded-full bg-[var(--panel2)]" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={width}><span className={"block h-full rounded-full " + tone.split(" ")[1]} style={{ width: width + "%" }}/></div>{ratio !== null && <p className="muted mt-1 text-[10px]">{Math.round(ratio * 100)}% da referência</p>}</article>;
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
    {mode === "result" && <BusinessResultCharts month={month} transactions={allTransactions} currency={profile.default_currency}/>}
    {mode === "cashflow" && <BusinessCashflowCharts month={month} transactions={allTransactions} events={events} openingCents={cashBalanceCents} currency={profile.default_currency}/>}
    {mode === "result" ? <>
      <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><Metric label="Faturamento realizado" item={snapshot.grossRevenue} currency={profile.default_currency}/><Metric label="Despesas registradas" item={snapshot.registeredExpenses} currency={profile.default_currency}/><Metric label="Resultado gerencial" item={snapshot.managerialResult} currency={profile.default_currency}/><PercentageMetric label="Margem bruta" percent={snapshot.grossMarginPercent} nature={snapshot.grossResultDre.nature} explanation="Resultado bruto gerencial dividido pela receita líquida. Só aparece quando as linhas necessárias estão preenchidas."/></div>
      <section className="panel mt-4 rounded-2xl p-5"><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">DRE gerencial simplificada</h3><span className="muted text-[11px]">Valores informados e cálculos gerenciais</span></div><div className="mt-4 space-y-3 text-sm"><DreRow label="Receita bruta" item={snapshot.grossDre} currency={profile.default_currency}/><DreRow label="(−) Impostos provisionados" item={snapshot.taxesDre} currency={profile.default_currency}/><DreRow label="Receita líquida" item={snapshot.netRevenueDre} currency={profile.default_currency} strong/><DreRow label="(−) Custos diretos" item={snapshot.directCostsDre} currency={profile.default_currency}/><DreRow label="Resultado bruto" item={snapshot.grossResultDre} currency={profile.default_currency} strong/><DreRow label="(−) Despesas operacionais" item={snapshot.operatingExpensesDre} currency={profile.default_currency}/><DreRow label="Resultado operacional" item={snapshot.operatingResultDre} currency={profile.default_currency} strong/><DreRow label="Resultado gerencial" item={snapshot.managerialResult} currency={profile.default_currency} strong/></div><p className="muted mt-4 text-xs leading-5">Entradas, despesas e premissas são identificadas pela origem. Transferências, aportes e aplicações não representam faturamento operacional.</p></section>
    </> : <>
      <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><section className="panel rounded-2xl p-4"><p className="muted text-xs">Caixa atual</p><b className="mt-2 block text-xl">{formatBusinessMoney(cashBalanceCents, profile.default_currency)}</b></section>{[30, 60, 90].map((days) => <section className="panel rounded-2xl p-4" key={days}><p className="muted text-xs">Caixa projetado · {days} dias</p><b className="mt-2 block text-xl">{formatBusinessMoney(projectedBusinessCash(cashBalanceCents, events, days), profile.default_currency)}</b></section>)}</div>
      <section className="panel mt-4 rounded-2xl p-5"><div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="font-semibold">Próximos compromissos</h3><p className="muted mt-1 text-xs">Projeção simples em regime de caixa, com recebíveis e contas programadas.</p></div><span className="rounded-full bg-[var(--panel2)] px-2.5 py-1 text-[11px]">{events.length} eventos</span></div>{events.length ? <div className="mt-3 divide-y divide-[var(--border)]">{events.slice(0, 30).map((event) => <div key={event.id} className="flex items-center justify-between gap-3 py-3"><span className="min-w-0"><b className="block truncate text-sm">{event.label}</b><small className="muted">{new Intl.DateTimeFormat("pt-BR").format(new Date(`${event.date}T12:00:00`))} · {event.kind === "receivable" ? "A receber" : "A pagar"}</small></span><b className={`shrink-0 text-sm ${event.kind === "receivable" ? "text-[var(--accent)]" : "text-amber-300"}`}>{event.kind === "receivable" ? "+" : "−"}{formatBusinessMoney(event.amountCents, profile.default_currency)}</b></div>)}</div> : <p className="muted mt-4 text-sm">Sem recebimentos ou compromissos programados para os próximos 90 dias.</p>}<p className="muted mt-4 border-t border-[var(--border)] pt-3 text-xs leading-5">A projeção considera somente eventos programados e não conta transferências como entrada ou saída consolidada. Valores futuros podem mudar.</p></section>
    </>}
  </section>;
}

function BusinessResultCharts({ month, transactions, currency }: { month: Date; transactions: FinanceTransaction[]; currency: string }) {
  const points = Array.from({ length: 12 }, (_, index) => {
    const date = new Date(month.getFullYear(), month.getMonth() - 11 + index, 1);
    const period = monthKey(date);
    const totals = calculateBusinessPeriodResult(period, transactions);
    return { label: new Intl.DateTimeFormat("pt-BR", { month: "short" }).format(date).replace(".", ""), resultCents: totals.resultCents, marginPercent: totals.incomeCents > 0 ? totals.resultCents / totals.incomeCents * 100 : null };
  });
  const hasData = transactions.some((item) => (item.type === "income" || item.type === "expense") && item.date.slice(0, 7) >= monthKey(new Date(month.getFullYear(), month.getMonth() - 11, 1)) && item.date.slice(0, 7) <= monthKey(month));
  if (!hasData) return <div className="panel mt-4 rounded-2xl p-5"><h3 className="font-semibold">Evolução mensal</h3><p className="muted mt-2 text-sm">Registre receitas e despesas para acompanhar resultado e margem ao longo do tempo.</p></div>;
  return <div className="mt-4 grid gap-4 xl:grid-cols-2">
    <section className="panel min-w-0 rounded-2xl p-4 sm:p-5" aria-label="Resultado mensal"><h3 className="font-semibold">Resultado mensal</h3><p className="muted mt-1 text-xs">Receitas registradas menos despesas registradas.</p><div className="mt-3 h-56" role="img" aria-label="Gráfico de resultado mensal nos últimos 12 meses"><ResponsiveContainer width="100%" height="100%"><LineChart data={points}><CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false}/><XAxis dataKey="label" tick={{ fill: "var(--muted)", fontSize: 10 }} tickLine={false} axisLine={false}/><YAxis width={44} tick={{ fill: "var(--muted)", fontSize: 10 }} tickLine={false} axisLine={false} tickFormatter={(value: number) => new Intl.NumberFormat("pt-BR", { notation: "compact", maximumFractionDigits: 1 }).format(value / 100)}/><Tooltip formatter={(value) => formatBusinessMoney(Number(value), currency)} contentStyle={{ background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 12, color: "var(--fg)" }}/><ReferenceLine y={0} stroke="var(--border)"/><Line name="Resultado" type="monotone" dataKey="resultCents" stroke="#4edea3" strokeWidth={2.5} dot={{ r: 2 }} connectNulls={false}/></LineChart></ResponsiveContainer></div></section>
    <section className="panel min-w-0 rounded-2xl p-4 sm:p-5" aria-label="Evolução da margem"><h3 className="font-semibold">Evolução da margem</h3><p className="muted mt-1 text-xs">Resultado registrado ÷ faturamento registrado; não é margem contábil.</p><div className="mt-3 h-56" role="img" aria-label="Gráfico de margem operacional mensal"><ResponsiveContainer width="100%" height="100%"><LineChart data={points}><CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false}/><XAxis dataKey="label" tick={{ fill: "var(--muted)", fontSize: 10 }} tickLine={false} axisLine={false}/><YAxis width={44} tick={{ fill: "var(--muted)", fontSize: 10 }} tickLine={false} axisLine={false} tickFormatter={(value: number) => value + "%"}/><Tooltip formatter={(value) => Number(value).toLocaleString("pt-BR", { maximumFractionDigits: 1 }) + "%"} contentStyle={{ background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 12, color: "var(--fg)" }}/><ReferenceLine y={0} stroke="var(--border)"/><Line name="Margem registrada" type="monotone" dataKey="marginPercent" stroke="#60a5fa" strokeWidth={2.5} dot={{ r: 2 }} connectNulls={false}/></LineChart></ResponsiveContainer></div></section>
  </div>;
}

function BusinessCashflowCharts({ month, transactions, events, openingCents, currency }: { month: Date; transactions: FinanceTransaction[]; events: BusinessCashEvent[]; openingCents: number; currency: string }) {
  const [monthsShown, setMonthsShown] = useState(6);
  const cashPoints = useMemo(() => {
    const grouped = new Map<string, number>();
    for (const event of events) grouped.set(event.date, (grouped.get(event.date) || 0) + (event.kind === "receivable" ? event.amountCents : -event.amountCents));
    return [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right)).reduce((points, [date, delta]) => {
      const projectedCents = (points[points.length - 1]?.balanceCents || 0) + delta;
      return [...points, { label: new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit" }).format(new Date(date + "T12:00:00")), balanceCents: projectedCents }];
    }, [{ label: "Hoje", balanceCents: openingCents }]);
  }, [events, openingCents]);
  const periodPoints = Array.from({ length: monthsShown }, (_, index) => {
    const date = new Date(month.getFullYear(), month.getMonth() - monthsShown + index + 1, 1);
    const period = monthKey(date);
    const rows = transactions.filter((item) => item.date.startsWith(period + "-") && (item.type === "income" || item.type === "expense"));
    return { label: new Intl.DateTimeFormat("pt-BR", { month: "short" }).format(date).replace(".", ""), inflowsCents: rows.filter((item) => item.type === "income").reduce((sum, item) => sum + item.amountCents, 0), outflowsCents: rows.filter((item) => item.type === "expense").reduce((sum, item) => sum + item.amountCents, 0) };
  });
  const hasFlow = periodPoints.some((item) => item.inflowsCents || item.outflowsCents);
  return <div className="mt-4 grid gap-4 xl:grid-cols-2">
    <section className="panel min-w-0 rounded-2xl p-4 sm:p-5" aria-label="Saldo projetado"><h3 className="font-semibold">Saldo projetado · próximos 90 dias</h3><p className="muted mt-1 text-xs">Saldo atual ajustado por recebimentos e pagamentos programados.</p>{events.length ? <div className="mt-3 h-56" role="img" aria-label="Linha do saldo projetado para os próximos 90 dias"><ResponsiveContainer width="100%" height="100%"><LineChart data={cashPoints}><CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false}/><XAxis dataKey="label" tick={{ fill: "var(--muted)", fontSize: 10 }} tickLine={false} axisLine={false}/><YAxis width={44} tick={{ fill: "var(--muted)", fontSize: 10 }} tickLine={false} axisLine={false} tickFormatter={(value: number) => new Intl.NumberFormat("pt-BR", { notation: "compact", maximumFractionDigits: 1 }).format(value / 100)}/><Tooltip formatter={(value) => formatBusinessMoney(Number(value), currency)} contentStyle={{ background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 12, color: "var(--fg)" }}/><Line name="Saldo estimado" type="stepAfter" dataKey="balanceCents" stroke="#4edea3" strokeWidth={2.5} dot={false}/></LineChart></ResponsiveContainer></div> : <p className="muted mt-4 rounded-xl border border-dashed border-[var(--border)] p-4 text-sm">Cadastre recebimentos ou compromissos futuros para visualizar a projeção.</p>}</section>
    <section className="panel min-w-0 rounded-2xl p-4 sm:p-5" aria-label="Entradas e saídas"><div className="flex flex-wrap items-start justify-between gap-2"><div><h3 className="font-semibold">Entradas × saídas</h3><p className="muted mt-1 text-xs">Movimentações realizadas; transferências e aplicações são excluídas.</p></div><div className="flex gap-1" aria-label="Período do gráfico">{[3, 6, 12].map((count) => <button key={count} type="button" aria-pressed={monthsShown === count} onClick={() => setMonthsShown(count)} className={"min-h-8 rounded-lg px-2 text-[10px] " + (monthsShown === count ? "bg-[var(--accent)]/15 text-[var(--accent)]" : "muted hover:bg-[var(--panel2)]")}>{count} meses</button>)}</div></div>{hasFlow ? <div className="mt-3 h-56" role="img" aria-label={"Gráfico de entradas e saídas em " + monthsShown + " meses"}><ResponsiveContainer width="100%" height="100%"><BarChart data={periodPoints}><CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false}/><XAxis dataKey="label" tick={{ fill: "var(--muted)", fontSize: 10 }} tickLine={false} axisLine={false}/><YAxis width={44} tick={{ fill: "var(--muted)", fontSize: 10 }} tickLine={false} axisLine={false} tickFormatter={(value: number) => new Intl.NumberFormat("pt-BR", { notation: "compact", maximumFractionDigits: 1 }).format(value / 100)}/><Tooltip formatter={(value) => formatBusinessMoney(Number(value), currency)} contentStyle={{ background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 12, color: "var(--fg)" }}/><Legend/><Bar name="Entradas" dataKey="inflowsCents" fill="#4edea3" radius={[4, 4, 0, 0]}/><Bar name="Saídas" dataKey="outflowsCents" fill="#f59e0b" radius={[4, 4, 0, 0]}/></BarChart></ResponsiveContainer></div> : <p className="muted mt-4 rounded-xl border border-dashed border-[var(--border)] p-4 text-sm">Registre movimentações para comparar entradas e saídas.</p>}</section>
  </div>;
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
      <form onSubmit={(event) => void savePlan(event)} className="mt-4 grid gap-3 sm:grid-cols-2">{BUSINESS_PLAN_GOAL_KEYS.map((goalKey) => <label key={goalKey} className="block min-w-0 text-xs font-medium">{planGoalLabels[goalKey]}<MoneyInput className="field mt-1" value={planInputs[goalKey]} onValueChange={(value) => setPlanInputs((current) => ({ ...current, [goalKey]: value }))} placeholder="Não definido"/><small className="muted mt-1 block font-normal">{planGoals[goalKey] ? `Atualizado em ${planGoals[goalKey]?.referenceMonth.slice(0, 7)}` : "Deixe em branco para não definir uma meta."}</small></label>)}<div className="flex justify-end pt-1 sm:col-span-2"><button type="submit" disabled={saving !== "" || referenceYear.length !== 4} className="primary inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl px-4 text-sm font-semibold disabled:opacity-60 sm:w-auto"><Save size={15}/>{saving === "plan" ? "Salvando…" : "Salvar metas"}</button></div></form>
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
    <label htmlFor={`business-${metricKey}-amount`} className="min-w-0 text-xs font-medium">{assumptionLabels[metricKey]}<MoneyInput id={`business-${metricKey}-amount`} className="field mt-1" value={value} onValueChange={onValue} placeholder="Não informado" aria-describedby={`business-${metricKey}-context`}/><small id={`business-${metricKey}-context`} className="muted mt-1 block font-normal">{existing ? `${natureLabels[existing.nature]} · referência desde ${existing.referenceMonth.slice(0, 7)}` : "Você pode deixar em branco e preencher depois."}</small></label>
    <fieldset className="flex flex-wrap gap-2 text-xs"><legend className="sr-only">Natureza de {assumptionLabels[metricKey]}</legend><label htmlFor={reportedId} className={`inline-flex min-h-10 cursor-pointer items-center gap-2 rounded-xl px-3 ${nature === "reported" ? "bg-[var(--accent)]/15 text-[var(--accent)]" : "bg-[var(--panel2)]"}`}><input id={reportedId} type="radio" name={`nature-${metricKey}`} checked={nature === "reported"} onChange={() => onNature("reported")} className="accent-[var(--accent)]"/>Valor exato informado</label><label htmlFor={estimateId} className={`inline-flex min-h-10 cursor-pointer items-center gap-2 rounded-xl px-3 ${nature === "estimated" ? "bg-[var(--accent)]/15 text-[var(--accent)]" : "bg-[var(--panel2)]"}`}><input id={estimateId} type="radio" name={`nature-${metricKey}`} checked={nature === "estimated"} onChange={() => onNature("estimated")} className="accent-[var(--accent)]"/>Valor aproximado</label></fieldset>
  </div>;
}
