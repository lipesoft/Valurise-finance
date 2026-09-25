"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { ArrowDownLeft, ArrowUpRight, Building2, Info, Save } from "lucide-react";
import { accountBalance, formatBRL, type FinanceTransaction } from "@/lib/finance";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import {
  BUSINESS_ASSUMPTION_KEYS,
  calculateBusinessFinanceSnapshot,
  parseBusinessMoneyToCents,
  type BusinessAssumption,
  type BusinessAssumptionKey,
  type BusinessFinanceSnapshot,
  type FinancialDataNature,
} from "@/lib/business-finance";

type Profile = {
  legal_name: string; trade_name: string; cnpj: string; email: string | null; phone: string | null;
  postal_code: string | null; street: string | null; number: string | null; address_complement: string | null;
  neighborhood: string | null; city: string | null; state: string | null; activity_start_date: string | null;
  cnae: string | null; tax_regime: "mei" | "simples_nacional" | "lucro_presumido" | "lucro_real" | "other" | null;
  accountant_name: string | null; management_close_day: number | null; default_currency: string; timezone: string;
};
type AssumptionRecord = Partial<Record<BusinessAssumptionKey, BusinessAssumption | null>>;
type BusinessInstitutionData = { institutions?: { name: string; accounts: { name: string; balance: number }[] }[] };

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
const natureLabels: Record<FinancialDataNature, string> = {
  actual: "Realizado", reported: "Informado", estimated: "Estimado", projected: "Projetado", mixed: "Misto",
};

function monthKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}
function centsInput(amount: number | null | undefined) {
  return amount === null || amount === undefined ? "" : (amount / 100).toFixed(2).replace(".", ",");
}
function monthlyMoney(cents: number | null, currency = "BRL") {
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
  if (!nature) return <span className="muted rounded-full bg-[var(--panel2)] px-2 py-1 text-[10px]">Sem dados</span>;
  const tone = nature === "actual" ? "text-[var(--accent)]" : nature === "projected" ? "text-sky-300" : "text-amber-300";
  return <span className={`rounded-full bg-[var(--panel2)] px-2 py-1 text-[10px] font-medium ${tone}`}>{natureLabels[nature]}</span>;
}
function Metric({ label, item, currency = "BRL" }: { label: string; item: { amountCents: number | null; nature: FinancialDataNature | null; explanation: string }; currency?: string }) {
  return <article className="min-w-0 rounded-2xl border border-[var(--border)] bg-[var(--panel2)]/65 p-4" title={item.explanation}>
    <div className="flex flex-wrap items-center justify-between gap-2"><p className="muted text-xs">{label}</p>{natureBadge(item.nature)}</div>
    <p className="mt-2 break-words text-xl font-semibold tracking-tight sm:text-2xl">{monthlyMoney(item.amountCents, currency)}</p>
    <details className="muted mt-2 text-[11px]"><summary className="inline-flex cursor-pointer list-none items-center gap-1"><Info size={12}/> Como calculamos?</summary><p className="mt-1 leading-5">{item.explanation}</p></details>
  </article>;
}
function currentCash(data: BusinessInstitutionData, transactions: FinanceTransaction[]) {
  const accounts = (data.institutions || []).flatMap((institution) => institution.accounts.map((account) => ({
    name: `${institution.name} • ${account.name}`, balance: account.balance,
  })));
  if (!accounts.length) return null;
  return accounts.reduce((total, account) => total + accountBalance(account.balance, account.name, transactions), 0);
}

export function BusinessFinanceDashboard({
  workspaceId, month, data, allTransactions, go,
}: {
  workspaceId: string; month: Date; data: BusinessInstitutionData;
  allTransactions: FinanceTransaction[]; go: (view: "settings") => void;
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
      }).catch((cause) => {
        if (stale) return;
        setError(cause instanceof Error ? cause.message : "Não foi possível carregar o perfil empresarial.");
        setLoading(false);
      });
    return () => { stale = true; };
  }, [workspaceId, period]);
  const snapshot = useMemo(() => {
    const values = Object.values(assumptions).filter((item): item is BusinessAssumption => Boolean(item));
    return calculateBusinessFinanceSnapshot({
      period, transactions: allTransactions, assumptions: values,
      cashAvailableCents: currentCash(data, allTransactions),
    });
  }, [allTransactions, assumptions, data, period]);
  const previousActualRevenue = useMemo(() => {
    const previousDate = new Date(month.getFullYear(), month.getMonth() - 1, 1);
    const previousPeriod = monthKey(previousDate);
    const rows = allTransactions.filter((item) => item.type === "income" && monthKey(new Date(item.date)) === previousPeriod);
    return rows.length ? rows.reduce((sum, item) => sum + item.amountCents, 0) : null;
  }, [allTransactions, month]);
  const monthlyChange = snapshot.actualIncomeCount && previousActualRevenue !== null && previousActualRevenue > 0 && snapshot.grossRevenue.amountCents !== null
    ? Math.round((snapshot.grossRevenue.amountCents - previousActualRevenue) / previousActualRevenue * 1000) / 10 : null;

  if (loading) return <section aria-label="Resumo empresarial" className="panel mt-5 rounded-3xl p-5 sm:p-6"><p className="muted text-sm">Carregando indicadores empresariais…</p></section>;
  return <section aria-label="Resumo empresarial" className="panel mt-5 rounded-3xl p-4 sm:p-6">
    <header className="flex flex-wrap items-start justify-between gap-3"><div><div className="flex items-center gap-2"><Building2 size={17} className="text-[var(--accent)]"/><h2 className="text-lg font-semibold">Visão da empresa</h2></div><p className="muted mt-1 text-xs">Regime de caixa · movimentações registradas e referências informadas</p></div><button type="button" onClick={() => go("settings")} className="min-h-10 rounded-xl bg-[var(--panel2)] px-3 text-xs font-medium text-[var(--accent)]">Perfil financeiro</button></header>
    {error && <p role="alert" className="mt-4 rounded-xl border border-amber-400/30 bg-amber-400/10 p-3 text-xs leading-5 text-amber-100">{error} Para evitar números desatualizados, os indicadores não foram substituídos por zeros.</p>}
    <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <Metric label="Faturamento do período" item={snapshot.grossRevenue} currency={profile.default_currency}/>
      <Metric label="Resultado gerencial" item={snapshot.managerialResult} currency={profile.default_currency}/>
      <Metric label="Caixa disponível" item={snapshot.cashAvailable} currency={profile.default_currency}/>
      <Metric label="A receber · informado" item={snapshot.receivables} currency={profile.default_currency}/>
    </div>
    <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <Metric label="Despesas registradas" item={snapshot.registeredExpenses} currency={profile.default_currency}/>
      <Metric label="A pagar · informado" item={snapshot.payables} currency={profile.default_currency}/>
      <PercentageMetric label="Margem bruta" percent={snapshot.grossMarginPercent} nature={snapshot.grossResultDre.nature} explanation="Resultado bruto gerencial dividido pela receita líquida. Só aparece quando as linhas necessárias estão preenchidas." />
      <Metric label="Caixa projetado · 30 dias" item={snapshot.projectedCash30Days} currency={profile.default_currency}/>
    </div>
    {monthlyChange !== null && <p className="mt-3 text-xs text-[var(--accent)]">Faturamento registrado {monthlyChange > 0 ? "subiu" : monthlyChange < 0 ? "caiu" : "ficou estável"} {Math.abs(monthlyChange).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}% em relação ao mês anterior completo.</p>}
    {snapshot.actualVsReferencePercent !== null && <p className="muted mt-2 text-xs">Referência mensal informada: {monthlyMoney(snapshot.monthlyReference.amountCents, profile.default_currency)} · realizado até agora: {snapshot.actualVsReferencePercent.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}% da referência (mês em andamento).</p>}
    <div className="mt-5 grid gap-4 xl:grid-cols-2">
      <section className="rounded-2xl border border-[var(--border)] p-4"><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold">DRE gerencial simplificada</h3><span className="muted text-[10px]">Não é demonstração contábil ou fiscal</span></div><div className="mt-3 space-y-2 text-sm">
        <DreRow label="Receita bruta" item={snapshot.grossDre} currency={profile.default_currency}/>
        <DreRow label="(−) Impostos provisionados" item={snapshot.taxesDre} currency={profile.default_currency}/>
        <DreRow label="Receita líquida" item={snapshot.netRevenueDre} currency={profile.default_currency} strong/>
        <DreRow label="(−) Custos diretos" item={snapshot.directCostsDre} currency={profile.default_currency}/>
        <DreRow label="Resultado bruto" item={snapshot.grossResultDre} currency={profile.default_currency} strong/>
        <DreRow label="(−) Despesas operacionais" item={snapshot.operatingExpensesDre} currency={profile.default_currency}/>
        <DreRow label="Resultado operacional" item={snapshot.operatingResultDre} currency={profile.default_currency} strong/>
        <DreRow label="Resultado gerencial" item={snapshot.managerialResult} currency={profile.default_currency} strong/>
      </div></section>
      <section className="rounded-2xl border border-[var(--border)] p-4"><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold">Fluxo de caixa registrado</h3><span className="muted text-[10px]">Período selecionado · regime de caixa</span></div><div className="mt-3 space-y-3 text-sm">
        <FlowRow label="Saldo inicial derivado" amount={snapshot.cashflow.openingCents} icon="neutral" currency={profile.default_currency}/>
        <FlowRow label="Entradas registradas" amount={snapshot.cashflow.inflowsCents} icon="in" currency={profile.default_currency}/>
        <FlowRow label="Saídas registradas · inclui aportes" amount={snapshot.cashflow.outflowsCents} icon="out" currency={profile.default_currency}/>
        <FlowRow label="Saldo inicial informado · referência" amount={snapshot.initialCash.amountCents} icon="neutral" currency={profile.default_currency}/>
        <div className="border-t border-[var(--border)] pt-3"><FlowRow label="Saldo final derivado" amount={snapshot.cashflow.closingCents} icon="neutral" currency={profile.default_currency}/></div>
        <p className="muted text-[11px] leading-5">Saldo derivado dos saldos das contas e dos lançamentos registrados; transferências não alteram o caixa total. Valores informados não substituem o extrato.</p>
      </div></section>
    </div>
    <footer className="muted mt-4 flex flex-wrap items-center gap-2 border-t border-[var(--border)] pt-3 text-[10px]"><span className="inline-flex items-center gap-1"><Info size={12}/> Estimativas não substituem os valores registrados; projeções usam somente as contas a receber e pagar informadas.</span><span>Para configurar os valores, abra Perfil financeiro nas Configurações.</span></footer>
  </section>;
}

function DreRow({ label, item, currency, strong = false }: { label: string; item: { amountCents: number | null; nature: FinancialDataNature | null }; currency: string; strong?: boolean }) {
  return <div className={`flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border)]/60 pb-2 ${strong ? "font-semibold" : ""}`}><span>{label}</span><span className="inline-flex items-center gap-2 text-right">{natureBadge(item.nature)}<span className="min-w-28">{monthlyMoney(item.amountCents, currency)}</span></span></div>;
}
function PercentageMetric({ label, percent, nature, explanation }: { label: string; percent: number | null; nature: FinancialDataNature | null; explanation: string }) {
  return <article className="min-w-0 rounded-2xl border border-[var(--border)] bg-[var(--panel2)]/65 p-4" title={explanation}><div className="flex flex-wrap items-center justify-between gap-2"><p className="muted text-xs">{label}</p>{natureBadge(nature)}</div><p className="mt-2 break-words text-xl font-semibold tracking-tight sm:text-2xl">{percent === null ? "Sem dados suficientes" : `${percent.toLocaleString("pt-BR", { maximumFractionDigits: 2 })}%`}</p><details className="muted mt-2 text-[11px]"><summary className="inline-flex cursor-pointer list-none items-center gap-1"><Info size={12}/> Como calculamos?</summary><p className="mt-1 leading-5">{explanation}</p></details></article>;
}
function FlowRow({ label, amount, icon, currency }: { label: string; amount: number | null; icon: "neutral" | "in" | "out"; currency: string }) {
  const Icon = icon === "in" ? ArrowDownLeft : icon === "out" ? ArrowUpRight : null;
  return <div className="flex items-center justify-between gap-3"><span className="muted flex min-w-0 items-center gap-2">{Icon && <Icon size={14} className={icon === "in" ? "text-[var(--accent)]" : "text-amber-300"}/>}<span>{label}</span></span><b className="shrink-0">{monthlyMoney(amount, currency)}</b></div>;
}

export function BusinessFinanceSettings({ workspaceId, toast }: { workspaceId: string; toast: (message: string) => void }) {
  const [referenceMonth, setReferenceMonth] = useState(() => monthKey(new Date()));
  const [profile, setProfile] = useState<Profile>(blankProfile);
  const [assumptions, setAssumptions] = useState<AssumptionRecord>({});
  const [amountInputs, setAmountInputs] = useState<Record<BusinessAssumptionKey, string>>(() => Object.fromEntries(BUSINESS_ASSUMPTION_KEYS.map((key) => [key, ""])) as Record<BusinessAssumptionKey, string>);
  const [natures, setNatures] = useState<Record<BusinessAssumptionKey, "reported" | "estimated">>(() => Object.fromEntries(BUSINESS_ASSUMPTION_KEYS.map((key) => [key, "estimated"])) as Record<BusinessAssumptionKey, "reported" | "estimated">);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<"company" | "finance" | "">("");
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
        setAmountInputs(Object.fromEntries(BUSINESS_ASSUMPTION_KEYS.map((key) => [key, centsInput(nextAssumptions[key]?.amountCents)])) as Record<BusinessAssumptionKey, string>);
        setNatures(Object.fromEntries(BUSINESS_ASSUMPTION_KEYS.map((key) => [key, nextAssumptions[key]?.nature || "estimated"])) as Record<BusinessAssumptionKey, "reported" | "estimated">);
        setLoadedProfile(true); setLoading(false);
      }).catch((cause) => {
        if (stale) return;
        setError(cause instanceof Error ? cause.message : "Não foi possível carregar os dados empresariais.");
        setLoading(false);
      });
    return () => { stale = true; };
  }, [workspaceId, referenceMonth]);

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

  const updateProfile = (key: keyof Profile, value: string | number | null) => setProfile((current) => ({ ...current, [key]: value }));
  if (loading) return <section className="panel mt-5 rounded-2xl p-5"><p className="muted text-sm">Carregando o perfil da empresa…</p></section>;

  return <section className="mx-auto max-w-4xl px-4 pt-5 lg:px-10">
    <header><p className="muted text-xs">Configurações · Empresa</p><h2 className="mt-1 text-2xl font-semibold tracking-tight">Perfil financeiro da empresa</h2><p className="muted mt-2 max-w-2xl text-sm leading-6">Não precisa ter os números exatos agora. Você poderá informar valores aproximados e ajustá-los depois. Valores aproximados serão identificados como estimativas no Valurise.</p></header>
    {error && <p role="alert" className="mt-4 rounded-xl border border-[var(--danger)]/35 bg-[var(--danger)]/10 p-3 text-sm leading-5 text-[var(--danger)]">{error}</p>}
    <section className="panel mt-5 rounded-2xl p-4 sm:p-5"><div className="flex items-start justify-between gap-3"><div><h3 className="font-semibold">Dados da empresa</h3><p className="muted mt-1 text-xs">Informações cadastrais e gerenciais opcionais.</p></div><span className="rounded-full bg-[var(--panel2)] px-2.5 py-1 text-[10px]">{profile.trade_name || "Empresa"}</span></div>
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
    </section>

    <section className="panel mt-4 rounded-2xl p-4 sm:p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="font-semibold">Perfil financeiro gerencial</h3><p className="muted mt-1 text-xs">Referências não substituem as movimentações realizadas.</p></div><label className="block text-xs">Vigência<input aria-label="Mês de referência" type="month" className="field mt-1 min-h-10" value={referenceMonth} onChange={(event) => setReferenceMonth(event.target.value)}/></label></div>
      <form onSubmit={(event) => void saveFinance(event)} className="mt-4 space-y-3">
        {BUSINESS_ASSUMPTION_KEYS.map((key) => <AssumptionField key={key} metricKey={key} value={amountInputs[key]} nature={natures[key]} existing={assumptions[key] || null} onValue={(value) => setAmountInputs((current) => ({ ...current, [key]: value }))} onNature={(nature) => setNatures((current) => ({ ...current, [key]: nature }))}/>)}
        <div className="rounded-xl border border-[var(--border)] bg-[var(--panel2)]/65 p-3 text-xs leading-5"><p className="font-medium">Como esses valores são usados</p><p className="muted mt-1">O faturamento e as despesas do período vêm dos lançamentos quando existirem. Valores manuais permanecem como referências históricas; as estimativas não apagam nem alteram o extrato. DRE e projeções são gerenciais e não fazem apuração fiscal.</p></div>
        <div className="flex justify-end pt-1"><button type="submit" disabled={saving !== ""} className="primary inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl px-4 text-sm font-semibold disabled:opacity-60 sm:w-auto"><Save size={15}/>{saving === "finance" ? "Salvando…" : "Salvar perfil financeiro"}</button></div>
      </form>
      {loadedProfile && <p className="muted mt-3 text-[10px]">As alterações ficam vinculadas a este workspace empresarial e mantêm o histórico de valores informado.</p>}
    </section>
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
