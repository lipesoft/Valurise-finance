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
  investmentId?: string;
};
export const formatBRL = (cents: number) =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(
    cents / 100,
  );
export function calculateSummary(items: FinanceTransaction[]) {
  const incomeCents = items
      .filter((x) => x.type === "income")
      .reduce((n, x) => n + x.amountCents, 0),
    expenseCents = items
      .filter((x) => x.type === "expense")
      .reduce((n, x) => n + x.amountCents, 0),
    investmentCents = items
      .filter((x) => x.type === "investment")
      .reduce((n, x) => n + x.amountCents, 0),
    m = new Map<string, number>();
  items
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
) {
  return items.reduce(
    (n, x) =>
      x.type === "transfer"
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
  frequency: "monthly" | "yearly";
  active: boolean;
  paidMonth?: string;
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
      if (!item.active || item.paidMonth === monthKey) return false;
      if (item.frequency === "yearly" && activeMonth.getMonth() !== today.getMonth()) return false;
      return !isCurrent || item.dueDay >= today.getDate();
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
