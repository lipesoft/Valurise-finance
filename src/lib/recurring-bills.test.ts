import { describe, expect, it } from "vitest";
import {
  isRecurringBillPaidInMonth,
  isRecurringBillScheduledInMonth,
  recurringBillDueDay,
  setRecurringBillPaidInMonth,
} from "@/lib/recurring-bills";

describe("recorrência de compromissos", () => {
  it("agenda uma conta mensal somente a partir do mês escolhido", () => {
    const bill = { active: true, frequency: "monthly" as const, startMonth: "2026-10", dueDay: 12 };
    expect(isRecurringBillScheduledInMonth(bill, "2026-09")).toBe(false);
    expect(isRecurringBillScheduledInMonth(bill, "2026-10")).toBe(true);
    expect(isRecurringBillScheduledInMonth(bill, "2027-02")).toBe(true);
  });

  it("mantém o compromisso de uma vez apenas no mês definido", () => {
    const bill = { active: true, frequency: "once" as const, startMonth: "2026-10", dueDay: 8 };
    expect(isRecurringBillScheduledInMonth(bill, "2026-09")).toBe(false);
    expect(isRecurringBillScheduledInMonth(bill, "2026-10")).toBe(true);
    expect(isRecurringBillScheduledInMonth(bill, "2026-11")).toBe(false);
  });

  it("limita o vencimento ao último dia do mês", () => {
    expect(recurringBillDueDay({ dueDay: 31 }, "2026-02")).toBe(28);
    expect(recurringBillDueDay({ dueDay: 31 }, "2024-02")).toBe(29);
  });

  it("guarda pagamentos de cada ocorrência sem perder o mês anterior", () => {
    const september = setRecurringBillPaidInMonth({ id: "internet", frequency: "monthly" as const, dueDay: 10, paidMonth: "2026-09" }, "2026-10", true);
    expect(isRecurringBillPaidInMonth(september, "2026-09")).toBe(true);
    expect(isRecurringBillPaidInMonth(september, "2026-10")).toBe(true);

    const undone = setRecurringBillPaidInMonth(september, "2026-10", false);
    expect(isRecurringBillPaidInMonth(undone, "2026-09")).toBe(true);
    expect(isRecurringBillPaidInMonth(undone, "2026-10")).toBe(false);
  });
});
