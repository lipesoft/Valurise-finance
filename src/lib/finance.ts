import { addMonths } from "date-fns";
import { isRecurringBillPaidInMonth, isRecurringBillScheduledInMonth, recurringBillDueDay } from "@/lib/recurring-bills";

export type TransactionType = "income" | "expense" | "investment" | "transfer";
export type FinanceTransaction = {
  id: string;
  type: TransactionType;
  subtype?: string;
  amountCents: number;
  category: string;
  account: string;
  description?: string;
  date: string;
  createdAt: string;
  destinationAccount?: string;
  tags?: string[];
  attachmentUrl?: string;
  installment?: { current: number; total: number };
  installmentGroupId?: string;
  installmentTotalCents?: number;
  investmentId?: string;
  goalId?: string;
  sharedGoalId?: string;
};

const MAX_INSTALLMENTS = 48;

/** Divide a purchase into positive, integer-cent installments without losing cents. */
export function splitInstallmentCents(totalCents: number, count: number) {
  if (!Number.isSafeInteger(totalCents) || totalCents <= 0) {
    throw new Error("O valor total precisa ser maior que zero.");
  }
  if (!Number.isInteger(count) || count < 2 || count > MAX_INSTALLMENTS) {
    throw new Error(`Escolha entre 2 e ${MAX_INSTALLMENTS} parcelas.`);
  }
  if (count > totalCents) {
    throw new Error("O número de parcelas não pode superar o valor em centavos.");
  }

  const baseCents = Math.floor(totalCents / count);
  const extraCents = totalCents % count;
  return Array.from({ length: count }, (_, index) =>
    baseCents + (index < extraCents ? 1 : 0),
  );
}

/** Build one ledger row per card invoice, keeping the complete purchase linked. */
export function createInstallmentTransactions(
  transaction: FinanceTransaction,
  count: number,
  groupId: string,
): FinanceTransaction[] {
  const installments = splitInstallmentCents(transaction.amountCents, count);
  if (!groupId.trim()) throw new Error("O parcelamento precisa de um identificador.");
  const purchaseDate = new Date(transaction.date);
  if (Number.isNaN(purchaseDate.getTime())) {
    throw new Error("A data da compra não é válida.");
  }

  return installments.map((amountCents, index) => ({
    ...transaction,
    id: `${transaction.id}-parcela-${index + 1}`,
    amountCents,
    date: addMonths(purchaseDate, index).toISOString(),
    installment: { current: index + 1, total: count },
    installmentGroupId: groupId,
    installmentTotalCents: transaction.amountCents,
  }));
}

function isOnOrBeforeDay(value: string, day: Date) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  const transactionDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const cutoffDay = new Date(day.getFullYear(), day.getMonth(), day.getDate());
  return transactionDay <= cutoffDay;
}

function isEffectiveTransaction(transaction: FinanceTransaction, asOf: Date) {
  return isOnOrBeforeDay(transaction.date, asOf);
}

export const formatBRL = (cents: number) =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(
    cents / 100,
  );
export function calculateSummary(items: FinanceTransaction[], asOf = new Date()) {
  const effectiveItems = items.filter((item) => isEffectiveTransaction(item, asOf));
  const incomeCents = effectiveItems
      .filter((x) => x.type === "income")
      .reduce((n, x) => n + x.amountCents, 0),
    expenseCents = effectiveItems
      .filter((x) => x.type === "expense")
      .reduce((n, x) => n + x.amountCents, 0),
    investmentCents = effectiveItems
      .filter((x) => x.type === "investment")
      .reduce((n, x) => n + x.amountCents, 0),
    m = new Map<string, number>();
  effectiveItems
    .filter((x) => x.type === "expense")
    .forEach((x) =>
      m.set(x.category, (m.get(x.category) || 0) + x.amountCents),
    );
  return {
    incomeCents,
    expenseCents,
    investmentCents,
    balanceCents: incomeCents - expenseCents - investmentCents,
    topCategories: [...m]
      .map(([category, amountCents]) => ({ category, amountCents }))
      .sort((a, b) => b.amountCents - a.amountCents),
  };
}
export function accountBalance(
  initial: number,
  account: string,
  items: FinanceTransaction[],
  asOf = new Date(),
) {
  return items.reduce(
    (n, x) =>
      !isEffectiveTransaction(x, asOf)
        ? n
        : x.type === "transfer"
        ? n +
          (x.account === account
            ? -x.amountCents
            : x.destinationAccount === account
              ? x.amountCents
              : 0)
        : x.account !== account
          ? n
          : n + (x.type === "income" ? x.amountCents : -x.amountCents),
    initial,
  );
}

type LedgerSummaryState = {
  investments?: {
    id: string;
    contributedCents: number;
    currentCents?: number;
  }[];
  goals?: { id: string; currentCents: number }[];
  [key: string]: unknown;
};

function linkedTotals(
  transactions: FinanceTransaction[],
  belongsTo: (transaction: FinanceTransaction) => string | undefined,
) {
  const totals = new Map<string, number>();
  for (const transaction of transactions) {
    const id = belongsTo(transaction);
    if (id) totals.set(id, (totals.get(id) || 0) + transaction.amountCents);
  }
  return totals;
}

/**
 * Keep the card summaries aligned with their ledger rows. This delta-based
 * reconciliation preserves manually entered opening balances while making
 * edits and deletions to linked contributions reversible.
 */
export function reconcileLinkedBalances<T extends LedgerSummaryState>(
  data: T,
  previous: FinanceTransaction[],
  next: FinanceTransaction[],
): T {
  const previousInvestments = linkedTotals(
    previous,
    (transaction) => transaction.type === "investment" ? transaction.investmentId : undefined,
  );
  const nextInvestments = linkedTotals(
    next,
    (transaction) => transaction.type === "investment" ? transaction.investmentId : undefined,
  );
  const previousGoals = linkedTotals(
    previous,
    (transaction) => transaction.type === "transfer" ? transaction.goalId : undefined,
  );
  const nextGoals = linkedTotals(
    next,
    (transaction) => transaction.type === "transfer" ? transaction.goalId : undefined,
  );

  let changed = false;
  const investments = data.investments?.map((item) => {
    const previousTotal = previousInvestments.get(item.id) || 0;
    const nextTotal = nextInvestments.get(item.id) || 0;
    const delta = nextTotal - previousTotal;
    if (!delta) return item;
    changed = true;
    return {
      ...item,
      contributedCents: Math.max(0, item.contributedCents + delta),
      ...(item.currentCents === undefined
        ? {}
        : { currentCents: Math.max(0, item.currentCents + delta) }),
    };
  });
  const goals = data.goals?.map((item) => {
    const previousTotal = previousGoals.get(item.id) || 0;
    const nextTotal = nextGoals.get(item.id) || 0;
    const delta = nextTotal - previousTotal;
    if (!delta) return item;
    changed = true;
    return { ...item, currentCents: Math.max(0, item.currentCents + delta) };
  });

  return changed
    ? ({ ...data, ...(investments ? { investments } : {}), ...(goals ? { goals } : {}) } as T)
    : data;
}

/** Quantia mensal necessária para atingir uma meta no prazo informado. */
export function monthlyContributionNeeded(
  targetCents: number,
  currentCents: number,
  targetDate?: string,
  today = new Date(),
) {
  const remaining = Math.max(0, targetCents - currentCents);
  if (!targetDate || remaining === 0) return remaining;
  const target = new Date(`${targetDate}T12:00:00`);
  const months = Math.max(
    1,
    (target.getFullYear() - today.getFullYear()) * 12 +
      target.getMonth() -
      today.getMonth() +
      (target.getDate() >= today.getDate() ? 1 : 0),
  );
  return Math.ceil(remaining / months);
}

export function projectMonthEnd(
  spentCents: number,
  daysElapsed: number,
  daysInMonth: number,
) {
  if (daysElapsed < 1) return 0;
  return Math.round((spentCents / daysElapsed) * daysInMonth);
}

export type PlannedCommitment = {
  id: string;
  amountCents: number;
  dueDay: number;
  frequency: "once" | "monthly" | "yearly";
  active: boolean;
  paidMonth?: string;
  paidMonths?: string[];
  startMonth?: string;
  /** Planned contributions are optional commitments, never past investments. */
  isPlannedContribution?: boolean;
};

/**
 * Amounts still expected in the active financial month. Paid bills and past
 * due dates are excluded so that the same money is never committed twice.
 */
export function committedMoneyCents(
  commitments: PlannedCommitment[],
  activeMonth: Date,
  today = new Date(),
) {
  const monthKey = `${activeMonth.getFullYear()}-${String(activeMonth.getMonth() + 1).padStart(2, "0")}`;
  const currentMonthKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;
  const isCurrent = monthKey === currentMonthKey;
  return commitments
    .filter((item) => {
      if (!isRecurringBillScheduledInMonth(item, monthKey)) return false;
      if (isRecurringBillPaidInMonth(item, monthKey)) return false;
      const dueDay = recurringBillDueDay(item, monthKey);
      return !isCurrent || dueDay >= today.getDate();
    })
    .reduce((total, item) => total + item.amountCents, 0);
}

export function moneyAvailability(
  availableBalanceCents: number,
  commitments: PlannedCommitment[],
  activeMonth: Date,
  today = new Date(),
) {
  const committedCents = committedMoneyCents(commitments, activeMonth, today);
  return {
    committedCents,
    freeToSpendCents: availableBalanceCents - committedCents,
  };
}
