export type RecurringBillFrequency = "once" | "monthly" | "yearly";

export type RecurringBillSchedule = {
  active?: boolean;
  dueDay: number;
  frequency?: RecurringBillFrequency;
  startMonth?: string;
  paidMonth?: string;
  paidMonths?: string[];
};

const MONTH_KEY_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export function isValidMonthKey(value: string) {
  return MONTH_KEY_PATTERN.test(value);
}

export function isRecurringBillScheduledInMonth(
  bill: RecurringBillSchedule,
  monthKey: string,
) {
  if (bill.active === false || !isValidMonthKey(monthKey)) return false;
  const frequency = bill.frequency ?? "monthly";
  const startMonth = bill.startMonth;

  if (frequency === "once") return startMonth === monthKey;
  if (!startMonth || !isValidMonthKey(startMonth)) return true;
  if (monthKey < startMonth) return false;
  if (frequency === "yearly") return monthKey.slice(5) === startMonth.slice(5);
  return true;
}

export function recurringBillDueDay(
  bill: Pick<RecurringBillSchedule, "dueDay">,
  monthKey: string,
) {
  if (!isValidMonthKey(monthKey)) return bill.dueDay;
  const [year, month] = monthKey.split("-").map(Number);
  const daysInMonth = new Date(year, month, 0).getDate();
  return Math.min(Math.max(1, Math.trunc(bill.dueDay || 1)), daysInMonth);
}

export function isRecurringBillPaidInMonth(
  bill: Pick<RecurringBillSchedule, "paidMonth" | "paidMonths">,
  monthKey: string,
) {
  return bill.paidMonth === monthKey || (bill.paidMonths || []).includes(monthKey);
}

/**
 * Adds/removes only the chosen occurrence. Older records used one `paidMonth`;
 * migrate that value in memory so editing a later month never forgets it.
 */
export function setRecurringBillPaidInMonth<T extends RecurringBillSchedule>(
  bill: T,
  monthKey: string,
  paid: boolean,
): T {
  const paidMonths = new Set([...(bill.paidMonths || []), ...(bill.paidMonth ? [bill.paidMonth] : [])]);
  if (paid) paidMonths.add(monthKey);
  else paidMonths.delete(monthKey);
  return {
    ...bill,
    paidMonth: undefined,
    paidMonths: [...paidMonths].sort(),
  };
}
