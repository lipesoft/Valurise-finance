import { describe, expect, it } from "vitest";
import {
  firstDayOfMonthValue,
  getReceivableOccurrences,
  lastBusinessDayOfMonthValue,
  outstandingReceivablesCents,
  toIncomeTransaction,
  type PlannedReceivable,
} from "@/lib/receivables";

const monthly: PlannedReceivable = {
  id: "internet-client",
  name: "Mensalidade cliente",
  amountCents: 120_000,
  dueDate: "2026-01-31",
  frequency: "monthly",
};

describe("receivables", () => {
  it("provides first-day and last weekday shortcuts without mutating the month", () => {
    expect(firstDayOfMonthValue("2026-02")).toBe("2026-02-01");
    expect(lastBusinessDayOfMonthValue("2026-02")).toBe("2026-02-27");
    expect(lastBusinessDayOfMonthValue("2026-05")).toBe("2026-05-29");
  });

  it("clamps monthly dates to shorter months and keeps stable occurrence IDs", () => {
    const occurrence = getReceivableOccurrences([monthly], "2026-02", [], new Date("2026-02-01T12:00:00"))[0];
    expect(occurrence.dueDate).toBe("2026-02-28");
    expect(occurrence.occurrenceId).toBe("internet-client:2026-02");
  });

  it("repeats last-business-day plans using the last weekday of each month", () => {
    const occurrence = getReceivableOccurrences([{
      ...monthly,
      dueDate: "2026-01-30",
      dueRule: "last_business_day",
    }], "2026-02", [], new Date("2026-02-01T12:00:00"))[0];
    expect(occurrence.dueDate).toBe("2026-02-27");
  });

  it("keeps one-time receipts in their scheduled month only", () => {
    const once = { ...monthly, frequency: "once" as const };
    expect(getReceivableOccurrences([once], "2026-01")).toHaveLength(1);
    expect(getReceivableOccurrences([once], "2026-02")).toHaveLength(0);
  });

  it("marks only linked income as received and excludes it from outstanding amount", () => {
    const occurrence = getReceivableOccurrences([monthly], "2026-02", [], new Date("2026-02-01T12:00:00"))[0];
    expect(outstandingReceivablesCents([occurrence])).toBe(120_000);
    const transaction = toIncomeTransaction(occurrence, "Banco • Conta", "2026-02-03", new Date("2026-02-03T15:00:00Z"));
    expect(transaction.id).toBe("receivable:internet-client:2026-02");
    expect(getReceivableOccurrences([monthly], "2026-02", [transaction], new Date("2026-02-01T12:00:00"))[0].status).toBe("received");
    expect(outstandingReceivablesCents(getReceivableOccurrences([monthly], "2026-02", [transaction]))).toBe(0);
  });

  it("identifies overdue dates without changing the planned date", () => {
    const occurrence = getReceivableOccurrences([monthly], "2026-02", [], new Date("2026-03-02T12:00:00"))[0];
    expect(occurrence.status).toBe("overdue");
    expect(occurrence.dueDate).toBe("2026-02-28");
  });

  it("rejects an invalid receipt account or date instead of creating a ledger row", () => {
    const occurrence = getReceivableOccurrences([monthly], "2026-02", [], new Date("2026-02-01T12:00:00"))[0];
    expect(() => toIncomeTransaction(occurrence, " ")).toThrow("Selecione uma conta");
    expect(() => toIncomeTransaction(occurrence, "Banco", "2026-02-30")).toThrow("data do recebimento");
  });
});
