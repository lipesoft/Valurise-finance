import { describe, expect, it } from "vitest";
import { validatePersonalAiTransactionDraft } from "./actions";

const state = {
  data: {
    categories: ["Alimentação", "Salário"],
    institutions: [
      { name: "Nubank", accounts: [{ name: "Conta principal" }], cards: [{ name: "Platinum" }] },
    ],
  },
};
const today = new Date();
const todayString = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

describe("propostas de ação financeira da Val", () => {
  it("aceita somente uma receita/despesa com conta e categoria existentes", () => {
    expect(validatePersonalAiTransactionDraft({
      type: "expense", amountCents: 1290, category: "Alimentação",
      account: "Nubank • Conta principal", description: "Almoço", date: todayString,
    }, state)).toEqual({
      type: "expense", amountCents: 1290, category: "Alimentação",
      account: "Nubank • Conta principal", description: "Almoço", date: todayString,
    });
  });

  it("rejeita cartão, conta inexistente, categoria inventada e data futura", () => {
    const base = { type: "expense", amountCents: 1290, category: "Alimentação", account: "Nubank • Conta principal", description: "Almoço", date: todayString };
    expect(() => validatePersonalAiTransactionDraft({ ...base, account: "Nubank • Platinum" }, state)).toThrow("A conta precisa existir");
    expect(() => validatePersonalAiTransactionDraft({ ...base, category: "Cripto" }, state)).toThrow("A categoria precisa existir");
    const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
    const futureDate = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")}`;
    expect(() => validatePersonalAiTransactionDraft({ ...base, date: futureDate }, state)).toThrow("data de hoje ou anterior");
  });

  it("não aceita transferências, valores inválidos ou campos extras", () => {
    const base = { type: "expense", amountCents: 1290, category: "Alimentação", account: "Nubank • Conta principal", description: "Almoço", date: todayString };
    expect(() => validatePersonalAiTransactionDraft({ ...base, type: "transfer" }, state)).toThrow();
    expect(() => validatePersonalAiTransactionDraft({ ...base, amountCents: 0 }, state)).toThrow();
    expect(() => validatePersonalAiTransactionDraft({ ...base, destinationAccount: "Banco" }, state)).toThrow();
  });
});
