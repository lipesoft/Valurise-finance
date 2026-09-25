import type { FinanceTransaction } from "@/lib/finance";

export type FinancialDataNature = "actual" | "reported" | "estimated" | "projected" | "mixed";
export const BUSINESS_ASSUMPTION_KEYS = [
  "monthly_revenue",
  "direct_costs",
  "fixed_expenses",
  "variable_expenses",
  "payroll",
  "taxes",
  "receivables",
  "payables",
  "initial_cash",
] as const;
export type BusinessAssumptionKey = typeof BUSINESS_ASSUMPTION_KEYS[number];
export type BusinessAssumption = {
  metricKey: BusinessAssumptionKey;
  amountCents: number | null;
  nature: "reported" | "estimated";
  source: "manual";
  referenceMonth: string;
  createdAt?: string;
};
export type BusinessValue = {
  amountCents: number | null;
  nature: FinancialDataNature | null;
  source: string | null;
  explanation: string;
};
export type BusinessFinanceSnapshot = {
  period: string;
  grossRevenue: BusinessValue;
  registeredExpenses: BusinessValue;
  cashOperatingResult: BusinessValue;
  cashAvailable: BusinessValue;
  initialCash: BusinessValue;
  receivables: BusinessValue;
  payables: BusinessValue;
  workingCapital: BusinessValue;
  projectedCash30Days: BusinessValue;
  grossDre: BusinessValue;
  taxesDre: BusinessValue;
  netRevenueDre: BusinessValue;
  directCostsDre: BusinessValue;
  grossResultDre: BusinessValue;
  operatingExpensesDre: BusinessValue;
  operatingResultDre: BusinessValue;
  managerialResult: BusinessValue;
  grossMarginPercent: number | null;
  netMarginPercent: number | null;
  cashflow: { openingCents: number | null; inflowsCents: number | null; outflowsCents: number | null; closingCents: number | null };
  actualIncomeCount: number;
  actualExpenseCount: number;
  monthlyReference: BusinessValue;
  actualVsReferencePercent: number | null;
};

const noData = (explanation: string): BusinessValue => ({ amountCents: null, nature: null, source: null, explanation });
const value = (amountCents: number, nature: FinancialDataNature, source: string, explanation: string): BusinessValue => ({ amountCents, nature, source, explanation });
const monthPattern = /^\d{4}-(0[1-9]|1[0-2])$/;

function parseDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function inMonth(date: Date, month: string) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}` === month;
}

function validCents(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function assumptionFor(assumptions: BusinessAssumption[], key: BusinessAssumptionKey, month: string) {
  return assumptions
    .filter((item) => item.metricKey === key && item.referenceMonth <= `${month}-01` && validCents(item.amountCents))
    .sort((a, b) => b.referenceMonth.localeCompare(a.referenceMonth)
      || String(b.createdAt || "").localeCompare(String(a.createdAt || "")))[0] || null;
}

function fromAssumption(item: BusinessAssumption | null, label: string): BusinessValue {
  return item && validCents(item.amountCents)
    ? value(item.amountCents, item.nature, "manual", `${label} informado manualmente para referência a partir de ${item.referenceMonth.slice(0, 7)}.`)
    : noData(`Ainda não há ${label.toLocaleLowerCase("pt-BR")} informado para este período.`);
}

function combineNature(values: FinancialDataNature[]): FinancialDataNature {
  const unique = new Set(values);
  if (unique.size === 1) return values[0];
  if (unique.has("projected")) return "projected";
  if (unique.has("estimated") || unique.has("mixed")) return "mixed";
  if (unique.has("actual") && unique.has("reported")) return "mixed";
  return "mixed";
}

function derivedValue(cents: number | null, sources: BusinessValue[], explanation: string): BusinessValue {
  const known = sources.filter((item) => item.amountCents !== null && item.nature !== null);
  if (cents === null || known.length !== sources.length || !known.length) return noData(explanation);
  return value(cents, combineNature(known.map((item) => item.nature!)), "calculated", explanation);
}

/** Deterministic management indicators; absent inputs stay null, not zero. */
export function calculateBusinessFinanceSnapshot(args: {
  period: string;
  transactions: FinanceTransaction[];
  assumptions: BusinessAssumption[];
  cashAvailableCents: number | null;
  asOf?: Date;
}): BusinessFinanceSnapshot {
  const { period, transactions, assumptions } = args;
  if (!monthPattern.test(period)) throw new Error("O período empresarial precisa estar no formato AAAA-MM.");
  if (args.cashAvailableCents !== null && !Number.isSafeInteger(args.cashAvailableCents)) throw new Error("O saldo de caixa precisa estar em centavos inteiros.");
  const asOf = args.asOf || new Date();
  const [year, monthNumber] = period.split("-").map(Number);
  const periodStart = new Date(year, monthNumber - 1, 1);
  const periodEnd = new Date(year, monthNumber, 1);
  const transactionsInPeriod = transactions.filter((item) => {
    const date = parseDate(item.date);
    return date !== null && date >= periodStart && date < periodEnd && date <= asOf;
  });
  const incomeRows = transactionsInPeriod.filter((item) => item.type === "income");
  const expenseRows = transactionsInPeriod.filter((item) => item.type === "expense");
  const sumRows = (rows: FinanceTransaction[]) => rows.reduce((sum, item) => sum + item.amountCents, 0);
  const hasActualIncome = incomeRows.length > 0;
  const hasActualExpenses = expenseRows.length > 0;
  const actualRevenue = hasActualIncome
    ? value(sumRows(incomeRows), "actual", "transactions", `Receitas registradas no livro financeiro entre ${period}-01 e ${periodEnd.toISOString().slice(0, 10)}.`)
    : noData("Não há receitas registradas neste período.");
  const actualExpenses = hasActualExpenses
    ? value(sumRows(expenseRows), "actual", "transactions", `Despesas registradas no livro financeiro entre ${period}-01 e ${periodEnd.toISOString().slice(0, 10)}.`)
    : noData("Não há despesas registradas neste período.");
  const referenceRevenue = fromAssumption(assumptionFor(assumptions, "monthly_revenue", period), "faturamento médio mensal");
  const grossRevenue = hasActualIncome ? actualRevenue : referenceRevenue;
  const cashOperatingResult = hasActualIncome && hasActualExpenses
    ? value(sumRows(incomeRows) - sumRows(expenseRows), "actual", "transactions", "Receitas menos despesas registradas no período. Não equivale a lucro contábil.")
    : noData("São necessárias receitas e despesas registradas para calcular o resultado de caixa do período.");

  const taxes = fromAssumption(assumptionFor(assumptions, "taxes", period), "impostos provisionados");
  const directCosts = fromAssumption(assumptionFor(assumptions, "direct_costs", period), "custos diretos");
  const fixedExpenses = fromAssumption(assumptionFor(assumptions, "fixed_expenses", period), "despesas fixas");
  const variableExpenses = fromAssumption(assumptionFor(assumptions, "variable_expenses", period), "despesas variáveis");
  const payroll = fromAssumption(assumptionFor(assumptions, "payroll", period), "despesas com pessoal");
  const netRevenueDre = derivedValue(
    grossRevenue.amountCents !== null && taxes.amountCents !== null ? grossRevenue.amountCents - taxes.amountCents : null,
    [grossRevenue, taxes], "Informe receitas e impostos provisionados para estimar a receita líquida gerencial.",
  );
  const grossResultDre = derivedValue(
    netRevenueDre.amountCents !== null && directCosts.amountCents !== null ? netRevenueDre.amountCents - directCosts.amountCents : null,
    [netRevenueDre, directCosts], "Informe receita líquida e custos diretos para estimar o resultado bruto.",
  );
  const operatingInputs = [fixedExpenses, variableExpenses, payroll];
  const operatingExpensesDre = derivedValue(
    operatingInputs.every((item) => item.amountCents !== null)
      ? operatingInputs.reduce((total, item) => total + item.amountCents!, 0)
      : null,
    operatingInputs, "Informe despesas fixas, variáveis e pessoal para compor despesas operacionais.",
  );
  const operatingResultDre = derivedValue(
    grossResultDre.amountCents !== null && operatingExpensesDre.amountCents !== null
      ? grossResultDre.amountCents - operatingExpensesDre.amountCents
      : null,
    [grossResultDre, operatingExpensesDre], "Dados insuficientes para o resultado operacional gerencial.",
  );
  const managerialResult = operatingResultDre.amountCents !== null
    ? { ...operatingResultDre, explanation: "Resultado gerencial simplificado; combina receitas registradas ou referência informada com custos e despesas do perfil. Não é lucro contábil ou fiscal." }
    : noData("Preencha os dados de receita, impostos, custos diretos e despesas operacionais para calcular o resultado gerencial.");
  const grossMarginPercent = grossResultDre.amountCents !== null && netRevenueDre.amountCents !== null && netRevenueDre.amountCents > 0
    ? Math.round(grossResultDre.amountCents / netRevenueDre.amountCents * 10000) / 100 : null;
  const netMarginPercent = managerialResult.amountCents !== null && grossRevenue.amountCents !== null && grossRevenue.amountCents > 0
    ? Math.round(managerialResult.amountCents / grossRevenue.amountCents * 10000) / 100 : null;

  const receivables = fromAssumption(assumptionFor(assumptions, "receivables", period), "contas a receber estimadas");
  const payables = fromAssumption(assumptionFor(assumptions, "payables", period), "contas a pagar estimadas");
  const cashAvailable = args.cashAvailableCents === null
    ? noData("Cadastre uma conta empresarial para consultar o caixa disponível registrado.")
    : value(args.cashAvailableCents, "actual", "accounts_and_transactions", "Soma dos saldos atuais das contas do workspace, considerando as movimentações registradas.");
  const initialCash = fromAssumption(assumptionFor(assumptions, "initial_cash", period), "saldo inicial informado");
  const estimateBalances = [cashAvailable, receivables, payables];
  const forecastAmount = estimateBalances.every((item) => item.amountCents !== null)
    ? cashAvailable.amountCents! + receivables.amountCents! - payables.amountCents! : null;
  const projectedCash30Days = forecastAmount === null
    ? noData("Informe caixa disponível e estimativas de recebimentos e pagamentos para projetar o saldo. Recorrências futuras ainda não entram nesta projeção.")
    : value(forecastAmount, "projected", "cash_plus_reported_receivables_less_payables", "Projeção simples: caixa atual + recebimentos informados − pagamentos informados. Não inclui recorrências futuras.");
  const workingCapital = forecastAmount === null
    ? noData("Dados insuficientes para estimar o capital de giro (caixa, contas a receber e a pagar).")
    : derivedValue(forecastAmount, estimateBalances, "Capital de giro gerencial aproximado: caixa + recebíveis − pagamentos informados. Não é indicador contábil oficial.");

  const isCurrentOrPast = periodStart <= new Date(asOf.getFullYear(), asOf.getMonth() + 1, 1);
  let inflows: number | null = null;
  let outflows: number | null = null;
  let opening: number | null = null;
  let closing: number | null = null;
  if (args.cashAvailableCents !== null && isCurrentOrPast) {
    const currentCashFlow = (item: FinanceTransaction) => item.type === "income" ? item.amountCents
      : item.type === "expense" || item.type === "investment" ? -item.amountCents : 0;
    const movements = transactions.filter((item) => {
      const date = parseDate(item.date);
      return date !== null && date >= periodEnd && date <= asOf;
    }).reduce((sum, item) => sum + currentCashFlow(item), 0);
    closing = args.cashAvailableCents - movements;
    const periodCashMovements = transactionsInPeriod.filter((item) => ["income", "expense", "investment"].includes(item.type));
    inflows = periodCashMovements.filter((item) => item.type === "income").reduce((sum, item) => sum + item.amountCents, 0);
    outflows = periodCashMovements.filter((item) => item.type === "expense" || item.type === "investment").reduce((sum, item) => sum + item.amountCents, 0);
    opening = closing - inflows + outflows;
  }
  const actualVsReferencePercent = hasActualIncome && referenceRevenue.amountCents !== null && referenceRevenue.amountCents > 0
    ? Math.round((actualRevenue.amountCents! - referenceRevenue.amountCents) / referenceRevenue.amountCents * 10000) / 100 : null;

  return {
    period, grossRevenue, registeredExpenses: actualExpenses, cashOperatingResult, cashAvailable, initialCash,
    receivables, payables, workingCapital, projectedCash30Days,
    grossDre: grossRevenue, taxesDre: taxes, netRevenueDre, directCostsDre: directCosts, grossResultDre,
    operatingExpensesDre, operatingResultDre, managerialResult, grossMarginPercent, netMarginPercent,
    cashflow: { openingCents: opening, inflowsCents: inflows, outflowsCents: outflows, closingCents: closing },
    actualIncomeCount: incomeRows.length, actualExpenseCount: expenseRows.length,
    monthlyReference: referenceRevenue, actualVsReferencePercent,
  };
}

export function parseBusinessMoneyToCents(value: string): number | null {
  const raw = value.trim().replace(/\s|R\$/gi, "");
  if (!raw) return null;
  let normalized = raw;
  if (raw.includes(",")) normalized = raw.replace(/\./g, "").replace(",", ".");
  else if ((raw.match(/\./g) || []).length > 1 || /\.\d{3}$/.test(raw)) normalized = raw.replace(/\./g, "");
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return null;
  const [whole, fraction = ""] = normalized.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(cents) ? cents : null;
}
