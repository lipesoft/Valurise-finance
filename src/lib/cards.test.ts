import { describe, expect, it } from "vitest";
import {
  bestPurchaseDay,
  cardAccountLabel,
  cardDisplayLabel,
  normalizeCardNickname,
} from "./cards";

describe("melhor dia de compra", () => {
  it("usa o dia seguinte ao fechamento", () =>
    expect(bestPurchaseDay(10)).toBe(11));
  it("trata a virada após o último dia possível", () =>
    expect(bestPurchaseDay(31)).toBe(1));
  it("não calcula valores inválidos", () =>
    expect(bestPurchaseDay(0)).toBeUndefined());
});

describe("apelido de cartão", () => {
  it("não repete o tipo quando o apelido está vazio", () => {
    expect(cardDisplayLabel()).toBe("Crédito");
    expect(cardDisplayLabel("   ")).toBe("Crédito");
  });

  it("mostra o apelido opcional antes do tipo do cartão", () => {
    expect(cardDisplayLabel("  Platinum  ")).toBe("Platinum · crédito");
  });

  it("trata o antigo valor padrão Crédito como ausência de apelido", () => {
    expect(cardDisplayLabel("Crédito")).toBe("Crédito");
    expect(cardDisplayLabel("CREDITO")).toBe("Crédito");
    expect(cardAccountLabel("Crédito")).toBe("Crédito");
    expect(normalizeCardNickname("Crédito")).toBeUndefined();
  });

  it("preserva o apelido nos identificadores dos lançamentos", () => {
    expect(cardAccountLabel("Platinum")).toBe("Platinum");
  });
});
