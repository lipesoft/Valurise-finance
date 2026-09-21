import { describe, expect, it } from "vitest";
import { bestPurchaseDay } from "./cards";

describe("melhor dia de compra", () => {
  it("usa o dia seguinte ao fechamento", () =>
    expect(bestPurchaseDay(10)).toBe(11));
  it("trata a virada após o último dia possível", () =>
    expect(bestPurchaseDay(31)).toBe(1));
  it("não calcula valores inválidos", () =>
    expect(bestPurchaseDay(0)).toBeUndefined());
});
