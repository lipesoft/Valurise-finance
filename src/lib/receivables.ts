import type { FinanceTransaction } from "@/lib/finance";

export type PlannedReceivable = {
  id: string;
  name: string;
  amountCents: number;
  dueDate: string;
  frequency: "once" | "monthly";
  dueRule?: "day" | "last_business_day";
  category?: string;
  account?: string;
};

export type ReceivableOccurrence = PlannedReceivable & {
  occurrenceId: string;
  period: string;
  status: "pending" | "overdue" | "received";
};

function parseDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day, 12);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
    ? date
    : null;
}

function monthKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function isMonthKey(value: string) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

function lastBusinessDay(year: number, monthIndex: number) {
  const date = new Date(year, monthIndex + 1, 0, 12);
  while (date.getDay() === 0 || date.getDay() === 6) date.setDate(date.getDate() - 1);
  return date;
}

function dateValue(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function firstDayOfMonthValue(month: Date | string) {
  const date = typeof month === "string" ? parseDate(`${month}-01`) : month;
  if (!date) throw new Error("O mês informado não é válido.");
  return dateValue(new Date(date.getFullYear(), date.getMonth(), 1, 12));
}

/** Considers weekdays; public holidays depend on the city and are not inferred. */
export function lastBusinessDayOfMonthValue(month: Date | string) {
  const date = typeof month === "string" ? parseDate(`${month}-01`) : month;
  if (!date) throw new Error("O mês informado não é válido.");
  return dateValue(lastBusinessDay(date.getFullYear(), date.getMonth()));
}

function occurrenceDate(plan: PlannedReceivable, period: string) {
  const anchor = parseDate(plan.dueDate);
  if (!anchor || !isMonthKey(period)) return null;
  const [year, month] = period.split("-").map(Number);
  if (plan.dueRule === "last_business_day") return lastBusinessDay(year, month - 1);
  const day = Math.min(anchor.getDate(), new Date(year, month, 0).getDate());
  return new Date(year, month - 1, day, 12);
}

export function getReceivableOccurrences(
  plans: PlannedReceivable[],
  period: string,
  transactions: FinanceTransaction[] = [],
  today = new Date(),
): ReceivableOccurrence[] {
  if (!isMonthKey(period)) return [];
  const receivedIds = new Set(
    transactions
      .filter((transaction) => transaction.type === "income" && transaction.plannedIncomeOccurrenceId)
      .map((transaction) => transaction.plannedIncomeOccurrenceId),
  );
  const todayValue = dateValue(today);

  return plans.flatMap((plan) => {
    if (!plan || !plan.id || !plan.name?.trim() || !Number.isSafeInteger(plan.amountCents) || plan.amountCents <= 0) return [];
    const anchor = parseDate(plan.dueDate);
    if (!anchor) return [];
    const startPeriod = monthKey(anchor);
    if (plan.frequency === "once" && period !== startPeriod) return [];
    if (plan.frequency === "monthly" && period < startPeriod) return [];
    if (plan.frequency !== "once" && plan.frequency !== "monthly") return [];

    const due = occurrenceDate(plan, period);
    if (!due) return [];
    const dueDate = dateValue(due);
    const occurrenceId = `${plan.id}:${period}`;
    const status: ReceivableOccurrence["status"] = receivedIds.has(occurrenceId)
      ? "received"
      : dueDate < todayValue
        ? "overdue"
        : "pending";
    return [{
      ...plan,
      dueDate,
      occurrenceId,
      period,
      status,
    }];
  }).sort((left, right) => left.dueDate.localeCompare(right.dueDate) || left.name.localeCompare(right.name, "pt-BR"));
}

export function outstandingReceivablesCents(occurrences: ReceivableOccurrence[]) {
  return occurrences
    .filter((occurrence) => occurrence.status !== "received")
    .reduce((sum, occurrence) => sum + occurrence.amountCents, 0);
}

export function toIncomeTransaction(
  occurrence: ReceivableOccurrence,
  account: string,
  receivedDate = dateValue(new Date()),
  now = new Date(),
): FinanceTransaction {
  if (!account.trim()) throw new Error("Selecione uma conta para registrar o recebimento.");
  if (!parseDate(receivedDate)) throw new Error("A data do recebimento não é válida.");
  return {
    id: `receivable:${occurrence.occurrenceId}`,
    type: "income",
    amountCents: occurrence.amountCents,
    category: occurrence.category?.trim() || "Outras receitas",
    account: account.trim(),
    description: occurrence.name.trim(),
    date: new Date(`${receivedDate}T12:00:00`).toISOString(),
    createdAt: now.toISOString(),
    plannedIncomeOccurrenceId: occurrence.occurrenceId,
  };
}
