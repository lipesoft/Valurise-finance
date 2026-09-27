import { describe, expect, it } from "vitest";
import {
  inferBankIconId,
  inferCategoryIconId,
  isFinanceIconId,
  resolveCategoryIconId,
  resolveInstitutionIconId,
} from "@/lib/finance-icons";

describe("ícones financeiros", () => {
  it("reconhece bancos brasileiros por nomes e variações comuns", () => {
    expect(inferBankIconId("Nubank Ultravioleta")).toBe("bank-nubank");
    expect(inferBankIconId("Banco Itaú")).toBe("bank-itau");
    expect(inferBankIconId("Mercado Pago")).toBe("bank-mercadopago");
    expect(inferBankIconId("Carteira sem instituição")).toBeUndefined();
  });

  it("sugere símbolos coerentes para categorias sem exigir alterações no cadastro antigo", () => {
    expect(inferCategoryIconId("Conta de luz")).toBe("utilities");
    expect(inferCategoryIconId("Supermercado")).toBe("food");
    expect(inferCategoryIconId("Minha categoria nova")).toBe("other");
    expect(resolveCategoryIconId("Mercado")).toBe("food");
  });

  it("prioriza uma personalização válida e ignora valores inesperados", () => {
    expect(resolveInstitutionIconId({ name: "Nubank", iconId: "bank-itau" })).toBe("bank-itau");
    expect(resolveInstitutionIconId({ name: "Nubank", iconId: "<svg>" })).toBe("bank-nubank");
    expect(resolveCategoryIconId("Mercado", { Mercado: "health" })).toBe("health");
    expect(resolveCategoryIconId("Mercado", { Mercado: "bank-nubank" })).toBe("food");
    expect(isFinanceIconId("bank-nubank")).toBe(true);
    expect(isFinanceIconId("not-an-icon")).toBe(false);
  });
});
