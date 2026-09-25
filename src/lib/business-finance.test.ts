import { describe, expect, it } from "vitest";
import type { FinanceTransaction } from "@/lib/finance";
import { calculateBusinessFinanceSnapshot, parseBusinessMoneyToCents, type BusinessAssumption } from "./business-finance";

const period = "2025-04";
const row = (metricKey: BusinessAssumption["metricKey"], amountCents: number, nature: BusinessAssumption["nature"] = "estimated", referenceMonth = "2025-04-01"): BusinessAssumption => ({ metricKey, amountCents, nature, source: "manual", referenceMonth });
const transaction = (id: string, type: FinanceTransaction["type"], amountCents: number, date = "2025-04-05T12:00:00.000Z"): FinanceTransaction => ({
  id, type, amountCents, category: "Operação", account: "Conta principal", date, createdAt: date,
});
const completeAssumptions = (): BusinessAssumption[] => [
  row("monthly_revenue", 200_000), row("taxes", 10_000), row("direct_costs", 20_000),
  row("fixed_expenses", 10_000), row("variable_expenses", 5_000), row("payroll", 20_000),
  row("receivables", 30_000), row("payables", 20_000), row("initial_cash", 50_000),
];

describe("indicadores gerenciais empresariais", () => {
  it("prioriza receitas e despesas registradas e marca resultado misto", () => {
    const snapshot = calculateBusinessFinanceSnapshot({
      period, asOf: new Date("2025-04-30T23:00:00.000Z"), cashAvailableCents: 80_000,
      transactions: [transaction("in", "income", 100_000), transaction("out", "expense", 30_000)],
      assumptions: completeAssumptions(),
    });
    expect(snapshot.grossRevenue).toMatchObject({ amountCents: 100_000, nature: "actual", source: "transactions" });
    expect(snapshot.registeredExpenses).toMatchObject({ amountCents: 30_000, nature: "actual" });
    expect(snapshot.cashOperatingResult).toMatchObject({ amountCents: 70_000, nature: "actual" });
    expect(snapshot.managerialResult).toMatchObject({ amountCents: 35_000, nature: "mixed" });
    expect(snapshot.grossMarginPercent).toBe(77.78);
    expect(snapshot.netMarginPercent).toBe(35);
    expect(snapshot.projectedCash30Days).toMatchObject({ amountCents: 90_000, nature: "projected" });
  });

  it("usa a referência informada sem apresentar como realizado quando não há receitas", () => {
    const snapshot = calculateBusinessFinanceSnapshot({
      period, asOf: new Date("2025-04-30T23:00:00.000Z"), cashAvailableCents: null,
      transactions: [], assumptions: [row("monthly_revenue", 250_000, "estimated")],
    });
    expect(snapshot.grossRevenue).toMatchObject({ amountCents: 250_000, nature: "estimated", source: "manual" });
    expect(snapshot.actualIncomeCount).toBe(0);
    expect(snapshot.cashOperatingResult.amountCents).toBeNull();
    expect(snapshot.managerialResult.amountCents).toBeNull();
    expect(snapshot.cashAvailable.amountCents).toBeNull();
  });

  it("diferencia um zero registrado da ausência de dados", () => {
    const empty = calculateBusinessFinanceSnapshot({ period, transactions: [], assumptions: [], cashAvailableCents: null, asOf: new Date("2025-04-30T23:00:00.000Z") });
    const zeroCash = calculateBusinessFinanceSnapshot({ period, transactions: [], assumptions: [], cashAvailableCents: 0, asOf: new Date("2025-04-30T23:00:00.000Z") });
    expect(empty.grossRevenue.amountCents).toBeNull();
    expect(empty.cashAvailable.amountCents).toBeNull();
    expect(zeroCash.cashAvailable).toMatchObject({ amountCents: 0, nature: "actual" });
  });

  it("preserva a natureza informada e compara estimativa com realizado", () => {
    const snapshot = calculateBusinessFinanceSnapshot({
      period, asOf: new Date("2025-04-30T23:00:00.000Z"), cashAvailableCents: null,
      transactions: [transaction("in", "income", 100_000)],
      assumptions: [row("monthly_revenue", 125_000, "reported")],
    });
    expect(snapshot.monthlyReference).toMatchObject({ amountCents: 125_000, nature: "reported" });
    expect(snapshot.grossRevenue).toMatchObject({ amountCents: 100_000, nature: "actual" });
    expect(snapshot.actualVsReferencePercent).toBe(-20);
  });

  it("compara trechos equivalentes dos meses e inclui o ponto de equilíbrio somente com base suficiente", () => {
    const snapshot = calculateBusinessFinanceSnapshot({
      period: "2025-04", asOf: new Date("2025-04-10T23:00:00.000Z"), cashAvailableCents: null,
      transactions: [
        transaction("current", "income", 100_000, "2025-04-05T12:00:00.000Z"),
        transaction("previous-comparable", "income", 50_000, "2025-03-05T12:00:00.000Z"),
        transaction("previous-outside", "income", 100_000, "2025-03-11T12:00:00.000Z"),
      ],
      assumptions: completeAssumptions(),
    });
    expect(snapshot.previousPeriodRevenue).toMatchObject({ amountCents: 50_000, nature: "actual" });
    expect(snapshot.actualVsPreviousPercent).toBe(100);
    expect(snapshot.previousComparisonLabel).toBe("até 10 de março de 2025");
    expect(snapshot.comparisonIsPartial).toBe(true);
    expect(snapshot.contributionMarginPercent).toBe(82.5);
    expect(snapshot.breakEvenRevenue).toMatchObject({ amountCents: 36_364, nature: "estimated" });

    const insufficient = calculateBusinessFinanceSnapshot({
      period, transactions: [], assumptions: [row("fixed_expenses", 10_000)], cashAvailableCents: null,
      asOf: new Date("2025-04-30T23:00:00.000Z"),
    });
    expect(insufficient.breakEvenRevenue.amountCents).toBeNull();
  });

  it("calcula fluxo de caixa somente quando há saldo de conta conhecido", () => {
    const noCash = calculateBusinessFinanceSnapshot({ period, transactions: [transaction("in", "income", 40_000)], assumptions: [], cashAvailableCents: null, asOf: new Date("2025-04-30T23:00:00.000Z") });
    const cash = calculateBusinessFinanceSnapshot({ period, transactions: [transaction("in", "income", 40_000), transaction("out", "expense", 15_000)], assumptions: [], cashAvailableCents: 125_000, asOf: new Date("2025-04-30T23:00:00.000Z") });
    const future = calculateBusinessFinanceSnapshot({ period: "2025-05", transactions: [transaction("future", "income", 90_000, "2025-05-05T12:00:00.000Z")], assumptions: [], cashAvailableCents: 125_000, asOf: new Date("2025-04-30T23:00:00.000Z") });
    expect(noCash.cashflow.openingCents).toBeNull();
    expect(cash.cashflow).toEqual({ openingCents: 100_000, inflowsCents: 40_000, outflowsCents: 15_000, closingCents: 125_000 });
    expect(future.cashflow).toEqual({ openingCents: null, inflowsCents: null, outflowsCents: null, closingCents: null });
  });

  it("trata valores brasileiros em centavos sem ponto flutuante", () => {
    expect(parseBusinessMoneyToCents("R$ 50.000,25")).toBe(5_000_025);
    expect(parseBusinessMoneyToCents("50000.25")).toBe(5_000_025);
    expect(parseBusinessMoneyToCents("50000")).toBe(5_000_000);
    expect(parseBusinessMoneyToCents("")).toBeNull();
    expect(parseBusinessMoneyToCents("-20,00")).toBeNull();
  });
});
