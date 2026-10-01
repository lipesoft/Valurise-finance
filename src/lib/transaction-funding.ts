import { accountBalance, type FinanceTransaction } from "@/lib/finance";
import { cardAccountLabel } from "@/lib/cards";

export type FundingAccount = {
  id: string;
  name: string;
  balance: number;
};

export type FundingCard = {
  id: string;
  name?: string;
  limit: number;
};

export type FundingInstitution = {
  id: string;
  name: string;
  accounts: FundingAccount[];
  cards: FundingCard[];
};

export type FundingSourceOption = {
  id: string;
  label: string;
  accountLabel: string;
  kind: "account" | "card";
  availableCents: number;
  cardMode?: "credit" | "pix_credit";
};

function monthKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * Credit already committed to this month's invoice and to future installments.
 * Keep this definition in sync with the card invoice preview: historical
 * invoices belong to previous cycles, while future installment rows reserve
 * their part of the limit now.
 */
export function getCardCommittedCents(
  accountLabel: string,
  transactions: FinanceTransaction[],
  asOf = new Date(),
) {
  const currentMonth = monthKey(asOf);
  const currentInvoice = transactions
    .filter((item) =>
      item.type === "expense" &&
      item.account === accountLabel &&
      item.date.startsWith(currentMonth),
    )
    .reduce((total, item) => total + item.amountCents, 0);
  const futureInstallments = transactions
    .filter((item) =>
      item.type === "expense" &&
      item.account === accountLabel &&
      Boolean(item.installmentGroupId) &&
      item.date.slice(0, 7) > currentMonth,
    )
    .reduce((total, item) => total + item.amountCents, 0);

  return currentInvoice + futureInstallments;
}

export function getCardAvailableCents(
  limitCents: number,
  accountLabel: string,
  transactions: FinanceTransaction[],
  asOf = new Date(),
) {
  return Math.max(0, limitCents - getCardCommittedCents(accountLabel, transactions, asOf));
}

export function buildFundingSourceOptions(
  institutions: FundingInstitution[],
  transactions: FinanceTransaction[],
  asOf = new Date(),
): FundingSourceOption[] {
  return institutions.flatMap((institution) => [
    ...institution.accounts.map((account) => {
      const accountLabel = `${institution.name} • ${account.name}`;
      return {
        id: `account:${institution.id}:${account.id}`,
        label: accountLabel,
        accountLabel,
        kind: "account" as const,
        availableCents: accountBalance(account.balance, accountLabel, transactions, asOf),
      };
    }),
    ...institution.cards.flatMap((card) => {
      const accountName = cardAccountLabel(card.name);
      const accountLabel = `${institution.name} • ${accountName}`;
      const availableCents = getCardAvailableCents(card.limit, accountLabel, transactions, asOf);
      return [
        {
          id: `card:${institution.id}:${card.id}:credit`,
          label: `${institution.name} • ${accountName}`,
          accountLabel,
          kind: "card" as const,
          cardMode: "credit" as const,
          availableCents,
        },
        {
          id: `card:${institution.id}:${card.id}:pix-credit`,
          label: `${institution.name} • Pix no crédito · ${accountName}`,
          accountLabel,
          kind: "card" as const,
          cardMode: "pix_credit" as const,
          availableCents,
        },
      ];
    }),
  ]);
}

export function filterFundingOptions<T extends Pick<FundingSourceOption, "kind" | "availableCents">>(
  options: T[],
  amountCents: number,
  allowedKinds: FundingSourceOption["kind"][] = ["account", "card"],
) {
  return options.filter((option) =>
    allowedKinds.includes(option.kind) &&
    option.availableCents > 0 &&
    option.availableCents >= amountCents,
  );
}
