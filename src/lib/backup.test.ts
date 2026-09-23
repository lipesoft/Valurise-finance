import { describe, expect, it } from "vitest";
import { createValuriseBackup, parseValuriseBackup } from "./backup";

const data = {
  categories: ["Mercado"],
  institutions: [{ id: "bank-1", name: "Banco de teste", color: "#4edea3", accounts: [], cards: [] }],
  goals: [{ id: "goal-1", name: "Reserva", targetCents: 10000, currentCents: 5000 }],
  onboarded: true,
};
const transactions = [{
  id: "tx-1",
  type: "expense" as const,
  amountCents: 1200,
  category: "Mercado",
  account: "Conta teste",
  date: "2026-09-23T12:00:00.000Z",
  createdAt: "2026-09-23T12:00:00.000Z",
}];

describe("backup Valurise", () => {
  it("gera e lê um backup versionado preservando os dados financeiros", () => {
    const exportedAt = "2026-09-23T12:00:00.000Z";
    const backup = createValuriseBackup(data, transactions, exportedAt);
    const restored = parseValuriseBackup<typeof data, typeof transactions[number]>(JSON.stringify(backup));

    expect(backup.format).toBe("valurise-backup");
    expect(backup.version).toBe(1);
    expect(restored.data).toEqual(data);
    expect(restored.transactions).toEqual(transactions);
  });

  it("continua aceitando o formato JSON legado já exportado pelo app", () => {
    const legacy = JSON.stringify({ exportedAt: "2026-09-23T12:00:00.000Z", data, transactions });
    expect(parseValuriseBackup<typeof data, typeof transactions[number]>(legacy).transactions).toEqual(transactions);
  });

  it("recusa JSON inválido e arquivos que não correspondem ao formato", () => {
    expect(() => parseValuriseBackup("{" )).toThrow("JSON válido");
    expect(() => parseValuriseBackup(JSON.stringify({ data: {}, transactions: [] }))).toThrow("backup válido");
  });

  it("recusa versões futuras para evitar substituir dados com formato incompatível", () => {
    const future = { ...createValuriseBackup(data, transactions), version: 2 };
    expect(() => parseValuriseBackup(JSON.stringify(future))).toThrow("não é compatível");
  });

  it("recusa estruturas financeiras internas malformadas antes de restaurar", () => {
    const invalid = {
      ...createValuriseBackup(data, transactions),
      data: { ...data, institutions: [{ id: "bank", name: "Banco", color: "verde", accounts: [{ id: "account", name: "Conta", balance: "invalido" }], cards: [] }] },
    };

    expect(() => parseValuriseBackup(JSON.stringify(invalid))).toThrow("backup válido");
  });
});
