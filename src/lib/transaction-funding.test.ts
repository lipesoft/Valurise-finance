import { describe, expect, it } from "vitest";
import type { FinanceTransaction } from "@/lib/finance";
import {
  buildFundingSourceOptions,
  filterFundingOptions,
  getCardAvailableCents,
} from "./transaction-funding";

const transaction = (overrides: Partial<FinanceTransaction> = {}): FinanceTransaction => ({
  id: "tx-1",
  type: "expense",
  amountCents: 2500,
  category: "Compras",
  account: "Banco • Platinum",
  date: "2026-09-15T12:00:00.000Z",
  createdAt: "2026-09-15T12:00:00.000Z",
  ...overrides,
});

describe("funding source availability", () => {
  const institutions = [{
    id: "bank-1",
    name: "Banco",
    accounts: [
      { id: "account-1", name: "Conta", balance: 10_000 },
      { id: "account-2", name: "Zerada", balance: 0 },
    ],
    cards: [{ id: "card-1", name: "Platinum", limit: 20_000 }],
  }];

  it("deduz compras e parcelas futuras do limite disponível sem alterar o limite total", () => {
    const transactions = [
      transaction({ amountCents: 2500 }),
      transaction({ id: "installment-2", amountCents: 1000, date: "2026-10-15T12:00:00.000Z", installmentGroupId: "purchase-1" }),
      transaction({ id: "installment-3", amountCents: 1000, date: "2026-11-15T12:00:00.000Z", installmentGroupId: "purchase-1" }),
    ];

    expect(getCardAvailableCents(20_000, "Banco • Platinum", transactions, new Date("2026-09-20T12:00:00"))).toBe(15_500);
    expect(buildFundingSourceOptions(institutions, transactions, new Date("2026-09-20T12:00:00"))
      .find((option) => option.id === "card:bank-1:card-1:credit")?.availableCents).toBe(15_500);
  });

  it("oculta contas zeradas e fontes cujo saldo/limite não cobre o valor", () => {
    const options = buildFundingSourceOptions(institutions, [], new Date("2026-09-20T12:00:00"));

    expect(filterFundingOptions(options, 10_001, ["account"]).map((item) => item.accountLabel)).toEqual([]);
    expect(filterFundingOptions(options, 20_001, ["card"]).map((item) => item.id)).toEqual([]);
    expect(filterFundingOptions(options, 1, ["account"]).map((item) => item.accountLabel)).toEqual(["Banco • Conta"]);
  });

  it("só oferece limite positivo e as duas modalidades usam a mesma conta/cartão", () => {
    const options = buildFundingSourceOptions(institutions, [transaction({ amountCents: 20_000 })], new Date("2026-09-20T12:00:00"));
    expect(filterFundingOptions(options, 1, ["card"])).toEqual([]);

    const available = buildFundingSourceOptions(institutions, [], new Date("2026-09-20T12:00:00"))
      .filter((item) => item.kind === "card");
    expect(available.map((item) => item.cardMode)).toEqual(["credit", "pix_credit"]);
    expect(new Set(available.map((item) => item.accountLabel))).toEqual(new Set(["Banco • Platinum"]));
  });
});
