import { describe, it, expect } from "vitest";
import { accountBalance, calculateSummary, committedMoneyCents, moneyAvailability } from "./finance";
const t = (type: any, amountCents: number, account = "Nubank"): any => ({
  id: "x",
  type,
  amountCents,
  account,
  category: "Teste",
  date: "2026-09-19",
  createdAt: "2026-09-19",
});
describe("finanças", () => {
  it("não conta transferência no resultado", () =>
    expect(
      calculateSummary([t("income", 10000), t("transfer", 5000)]).balanceCents,
    ).toBe(10000));
  it("move saldo entre contas", () => {
    const x = { ...t("transfer", 5000), destinationAccount: "Inter" };
    expect(accountBalance(10000, "Nubank", [x])).toBe(5000);
    expect(accountBalance(0, "Inter", [x])).toBe(5000);
  });
  it("separa aporte de gasto de consumo e reduz a conta de origem", () => {
    const investment = t("investment", 2500, "Nubank");
    const summary = calculateSummary([t("income", 10000), investment]);
    expect(summary.expenseCents).toBe(0);
    expect(summary.investmentCents).toBe(2500);
    expect(accountBalance(10000, "Nubank", [investment])).toBe(7500);
  });
  it("considera só compromissos pendentes no dinheiro livre", () => {
    const items = [
      { id: "rent", amountCents: 100000, dueDay: 25, frequency: "monthly" as const, active: true },
      { id: "paid", amountCents: 20000, dueDay: 20, frequency: "monthly" as const, active: true, paidMonth: "2026-09" },
      { id: "past", amountCents: 30000, dueDay: 5, frequency: "monthly" as const, active: true },
    ];
    const today = new Date("2026-09-10T12:00:00");
    expect(committedMoneyCents(items, new Date("2026-09-01T12:00:00"), today)).toBe(100000);
    expect(moneyAvailability(250000, items, new Date("2026-09-01T12:00:00"), today)).toEqual({ committedCents: 100000, freeToSpendCents: 150000 });
  });
});
