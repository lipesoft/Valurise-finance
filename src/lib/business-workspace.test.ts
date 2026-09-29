import { describe, expect, it } from "vitest";
import { buildBusinessCashEvents, calculateAnnualRevenueOutlook, projectedBusinessCash } from "@/lib/business-finance";
import type { FinanceTransaction } from "@/lib/finance";

const tx = (id: string, type: FinanceTransaction["type"], amountCents: number, date: string): FinanceTransaction => ({
  id, type, amountCents, date: `${date}T12:00:00.000Z`, createdAt: `${date}T12:00:00.000Z`, category: "teste", account: "Conta",
});

describe("business workspace financial indicators", () => {
  it("projects annual revenue only after three revenue months and excludes transfers/investments", () => {
    const transactions = [
      tx("jan", "income", 100_000, "2026-01-12"),
      tx("feb", "income", 200_000, "2026-02-12"),
      tx("mar", "income", 300_000, "2026-03-12"),
      tx("transfer", "transfer", 900_000, "2026-03-18"),
      tx("investment", "investment", 800_000, "2026-03-18"),
    ];
    const outlook = calculateAnnualRevenueOutlook(2026, transactions, 1_000_000, new Date(2026, 3, 5));
    expect(outlook.actualCents).toBe(600_000);
    expect(outlook.forecastCents).toBe(1_800_000);
    expect(outlook.progressPercent).toBe(60);
  });

  it("does not invent a projection when transaction history is insufficient", () => {
    const outlook = calculateAnnualRevenueOutlook(2026, [tx("jan", "income", 100_000, "2026-01-12")], null, new Date(2026, 3, 5));
    expect(outlook.actualCents).toBe(100_000);
    expect(outlook.forecastCents).toBeNull();
    expect(outlook.goalCents).toBeNull();
  });

  it("does not count income dated after the reporting date", () => {
    const outlook = calculateAnnualRevenueOutlook(2026, [
      tx("jan", "income", 100_000, "2026-01-12"),
      tx("feb", "income", 200_000, "2026-02-12"),
      tx("mar", "income", 300_000, "2026-03-12"),
      tx("future", "income", 900_000, "2026-06-12"),
    ], null, new Date(2026, 4, 20));
    expect(outlook.actualCents).toBe(600_000);
    expect(outlook.forecastCents).toBe(1_440_000);
  });

  it("projects receipts and payables without treating transfers as operating cashflow", () => {
    const from = new Date(2026, 8, 1, 12);
    const events = buildBusinessCashEvents({
      from,
      days: 90,
      transactions: [tx("received", "income", 5_000, "2026-09-01")],
      receivables: [{ id: "sale", name: "Venda futura", amountCents: 120_000, dueDate: "2026-09-15", frequency: "once" }],
      payables: [{ id: "rent", name: "Aluguel", amountCents: 60_000, dueDay: 10, frequency: "monthly", active: true, startMonth: "2026-09" }],
    });
    expect(events.map((event) => [event.kind, event.amountCents])).toEqual([["payable", 60_000], ["receivable", 120_000], ["payable", 60_000], ["payable", 60_000]]);
    expect(projectedBusinessCash(200_000, events, 30, from)).toBe(260_000);
  });
});
