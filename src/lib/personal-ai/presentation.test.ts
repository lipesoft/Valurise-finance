import { describe, expect, it } from "vitest";
import { formatValResponse } from "./presentation";

describe("formatação das respostas da Val", () => {
  it("remove negrito cru e organiza títulos e listas antigas", () => {
    const response = formatValResponse(
      "Boa pergunta! **O que eu sou:** Sou a Val. **O que posso fazer:** - 📊 Mostrar receitas - 💳 Listar contas - 🧾 Consultar faturas",
    );

    expect(response).toContain("\n\nO que eu sou:\n");
    expect(response).toContain("\n\nO que posso fazer:\n• 📊 Mostrar receitas\n• Listar contas\n• Consultar faturas");
    expect(response).not.toContain("**");
    expect(response).not.toContain("💳");
    expect(response).not.toContain("🧾");
  });

  it("preserva parágrafos, listas simples e passos numerados", () => {
    const response = formatValResponse("Primeiro, confira o período.\n\n- Veja os gastos\n- Compare com o limite\n\n1. Abra o orçamento\n2. Ajuste o valor");

    expect(response).toBe("Primeiro, confira o período.\n\n• Veja os gastos\n• Compare com o limite\n\n1. Abra o orçamento\n2. Ajuste o valor");
  });

  it("normaliza quebras de linha e remove títulos Markdown sem gerar HTML", () => {
    const response = formatValResponse("### Resumo\r\n\r\n**Você gastou R$ 120.**");

    expect(response).toBe("Resumo\n\nVocê gastou R$ 120.");
    expect(response).not.toContain("<");
  });
});
