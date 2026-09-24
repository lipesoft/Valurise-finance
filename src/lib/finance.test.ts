import { describe, expect, it } from "vitest";
import {
  accountBalance,
  calculateSummary,
  committedMoneyCents,
  createInstallmentTransactions,
  formatBRL,
  moneyAvailability,
  monthlyContributionNeeded,
  projectMonthEnd,
  reconcileLinkedBalances,
  splitInstallmentCents,
  type FinanceTransaction,
} from "./finance";

const t = (
  type: FinanceTransaction["type"],
  amountCents: number,
  account = "Nubank",
  category = "Teste",
): FinanceTransaction => ({
  id: `${type}-${account}`,
  type,
  amountCents,
  account,
  category,
  date: "2026-09-19",
  createdAt: "2026-09-19",
});

describe("finanças", () => {
  it("não conta transferência no resultado", () =>
    expect(
      calculateSummary([t("income", 10000), t("transfer", 5000)]).balanceCents,
    ).toBe(10000));

  it("agrupa somente despesas por categoria e ordena pelo maior gasto", () => {
    const summary = calculateSummary([
      t("expense", 2500, "Nubank", "Mercado"),
      t("expense", 4000, "Nubank", "Moradia"),
      t("expense", 1000, "Nubank", "Mercado"),
      t("investment", 9000, "Nubank", "CDB"),
      t("transfer", 7000, "Nubank", "Transferência"),
    ]);

    expect(summary.topCategories).toEqual([
      { category: "Moradia", amountCents: 4000 },
      { category: "Mercado", amountCents: 3500 },
    ]);
  });

  it("move saldo entre contas", () => {
    const transfer = { ...t("transfer", 5000), destinationAccount: "Inter" };
    expect(accountBalance(10000, "Nubank", [transfer])).toBe(5000);
    expect(accountBalance(0, "Inter", [transfer])).toBe(5000);
  });

  it("divide compras parceladas em centavos exatos", () => {
    const installments = splitInstallmentCents(10000, 3);

    expect(installments).toEqual([3334, 3333, 3333]);
    expect(installments.reduce((total, cents) => total + cents, 0)).toBe(10000);
  });

  it("distribui parcelas mensalmente e mantém o dia de fim de mês", () => {
    const rows = createInstallmentTransactions(
      {
        ...t("expense", 10000, "Nubank • Platinum"),
        date: "2026-01-31T12:00:00.000Z",
      },
      3,
      "purchase-1",
    );

    expect(rows.map((row) => row.date.slice(0, 10))).toEqual([
      "2026-01-31",
      "2026-02-28",
      "2026-03-31",
    ]);
    expect(rows.map((row) => row.installment?.current)).toEqual([1, 2, 3]);
    expect(rows.every((row) => row.installmentGroupId === "purchase-1")).toBe(true);
    expect(rows.reduce((total, row) => total + row.amountCents, 0)).toBe(10000);
  });

  it("não permite parcelamento maior que 48 vezes ou que gere parcela zerada", () => {
    expect(() => splitInstallmentCents(10000, 49)).toThrow();
    expect(() => splitInstallmentCents(2, 3)).toThrow();
  });

  it("separa aporte de gasto de consumo e reduz a conta de origem", () => {
    const investment = t("investment", 2500, "Nubank");
    const summary = calculateSummary([t("income", 10000), investment]);

    expect(summary.expenseCents).toBe(0);
    expect(summary.investmentCents).toBe(2500);
    expect(accountBalance(10000, "Nubank", [investment])).toBe(7500);
  });

  it("reconcilia aportes ligados a investimento ao criar, editar e excluir", () => {
    const item = { id: "cdb-1", contributedCents: 5000, currentCents: 6200 };
    const data = { investments: [item] };
    const contribution = { ...t("investment", 1200), id: "aporte-1", investmentId: "cdb-1" };
    const added = reconcileLinkedBalances(data, [], [contribution]);
    const edited = reconcileLinkedBalances(added, [contribution], [{ ...contribution, amountCents: 2000 }]);
    const deleted = reconcileLinkedBalances(edited, [{ ...contribution, amountCents: 2000 }], []);

    expect(added.investments?.[0]).toEqual({ ...item, contributedCents: 6200, currentCents: 7400 });
    expect(edited.investments?.[0]).toEqual({ ...item, contributedCents: 7000, currentCents: 8200 });
    expect(deleted.investments?.[0]).toEqual(item);
  });

  it("reconcilia contribuição de meta sem classificá-la como consumo", () => {
    const data = { goals: [{ id: "goal-1", currentCents: 10000 }] };
    const contribution: FinanceTransaction = {
      ...t("transfer", 2500, "Nubank • Conta"),
      id: "goal-contribution-1",
      goalId: "goal-1",
      destinationAccount: "Meta • Reserva",
    };
    const afterAdd = reconcileLinkedBalances(data, [], [contribution]);
    const afterDelete = reconcileLinkedBalances(afterAdd, [contribution], []);

    expect(afterAdd.goals?.[0].currentCents).toBe(12500);
    expect(calculateSummary([contribution], new Date("2026-09-20T12:00:00")).expenseCents).toBe(0);
    expect(afterDelete.goals?.[0].currentCents).toBe(10000);
  });

  it("não antecipa lançamentos futuros no saldo ou nos totais realizados", () => {
    const future = { ...t("expense", 5000, "Nubank"), date: "2026-10-01T12:00:00.000Z" };
    const asOf = new Date("2026-09-23T12:00:00.000Z");

    expect(accountBalance(10000, "Nubank", [future], asOf)).toBe(10000);
    expect(calculateSummary([future], asOf).expenseCents).toBe(0);
    expect(calculateSummary([future], new Date("2026-10-01T12:00:00.000Z")).expenseCents).toBe(5000);
  });

  it("não altera o saldo de contas que não participam da movimentação", () => {
    const items = [
      t("income", 5000, "Inter"),
      t("expense", 2500, "Inter"),
      { ...t("transfer", 1000, "Nubank"), destinationAccount: "Inter" },
    ];

    expect(accountBalance(20000, "Banco do Brasil", items)).toBe(20000);
    expect(accountBalance(10000, "Inter", items)).toBe(13500);
  });

  it("considera só compromissos pendentes no dinheiro livre", () => {
    const items = [
      { id: "rent", amountCents: 100000, dueDay: 25, frequency: "monthly" as const, active: true },
      { id: "paid", amountCents: 20000, dueDay: 20, frequency: "monthly" as const, active: true, paidMonth: "2026-09" },
      { id: "past", amountCents: 30000, dueDay: 5, frequency: "monthly" as const, active: true },
    ];
    const today = new Date("2026-09-10T12:00:00");
    const month = new Date("2026-09-01T12:00:00");

    expect(committedMoneyCents(items, month, today)).toBe(100000);
    expect(moneyAvailability(250000, items, month, today)).toEqual({
      committedCents: 100000,
      freeToSpendCents: 150000,
    });
  });

  it("inclui vencimento de hoje e exclui compromissos inativos e vencidos no mês atual", () => {
    const items = [
      { id: "today", amountCents: 5000, dueDay: 10, frequency: "monthly" as const, active: true },
      { id: "past", amountCents: 9000, dueDay: 9, frequency: "monthly" as const, active: true },
      { id: "inactive", amountCents: 15000, dueDay: 20, frequency: "monthly" as const, active: false },
    ];

    expect(
      committedMoneyCents(
        items,
        new Date("2026-09-01T12:00:00"),
        new Date("2026-09-10T12:00:00"),
      ),
    ).toBe(5000);
  });

  it("calcula a contribuição mensal arredondando para cima e zera uma meta atingida", () => {
    const today = new Date("2026-09-01T12:00:00");

    expect(monthlyContributionNeeded(300001, 60000, "2026-12-01", today)).toBe(60001);
    expect(monthlyContributionNeeded(300000, 300000, "2026-12-01", today)).toBe(0);
  });

  it("projeta o ritmo mensal e não divide por zero ou dias negativos", () => {
    expect(projectMonthEnd(4200, 7, 30)).toBe(18000);
    expect(projectMonthEnd(4200, 0, 30)).toBe(0);
    expect(projectMonthEnd(4200, -1, 30)).toBe(0);
  });

  it("formata centavos no padrão monetário brasileiro", () => {
    expect(formatBRL(123456)).toContain("1.234,56");
  });
});
