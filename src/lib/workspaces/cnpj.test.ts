import { describe, expect, it } from "vitest";
import { isValidCnpj, normalizeCnpj } from "./cnpj";

describe("CNPJ empresarial", () => {
  it("normaliza pontuação e valida os dígitos verificadores", () => {
    expect(normalizeCnpj("11.222.333/0001-81")).toBe("11222333000181");
    expect(isValidCnpj("11.222.333/0001-81")).toBe(true);
  });

  it("rejeita CNPJ repetido, incompleto ou com dígito inválido", () => {
    expect(isValidCnpj("00.000.000/0000-00")).toBe(false);
    expect(isValidCnpj("11.222.333/0001-80")).toBe(false);
    expect(isValidCnpj("1122233300018")).toBe(false);
  });
});
