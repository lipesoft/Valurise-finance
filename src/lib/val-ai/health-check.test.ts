import { describe, expect, it } from "vitest";
import { getValHealthCheckPrompt, isValHealthCheckSuccessful, VAL_HEALTH_CHECK_TOOL_NAME } from "./health-check";

describe("Val AI health check", () => {
  it("instrui o modelo a chamar a ferramenta sem exigir geração textual adicional", () => {
    const prompt = getValHealthCheckPrompt(true);

    expect(prompt).toContain(VAL_HEALTH_CHECK_TOOL_NAME);
    expect(prompt).toMatch(/chame a ferramenta/i);
    expect(prompt).not.toMatch(/depois que ela retornar|responda somente/i);
  });

  it("usa resposta mínima sem ferramentas quando a capacidade não é exigida", () => {
    expect(getValHealthCheckPrompt(false)).toBe("Responda somente: OK.");
  });

  it("aceita a chamada de ferramenta validada sem exigir uma segunda geração de texto", () => {
    expect(isValHealthCheckSuccessful({ text: "", steps: [{ toolCalls: [{ toolName: VAL_HEALTH_CHECK_TOOL_NAME }] }] }, true)).toBe(true);
  });

  it("rejeita uma resposta textual sem chamada de ferramenta quando a capacidade é exigida", () => {
    expect(isValHealthCheckSuccessful({ text: "OK", steps: [{ toolCalls: [] }] }, true)).toBe(false);
  });

  it("exige texto quando o teste não verifica ferramentas", () => {
    expect(isValHealthCheckSuccessful({ text: " OK ", steps: [] }, false)).toBe(true);
    expect(isValHealthCheckSuccessful({ text: " ", steps: [] }, false)).toBe(false);
  });
});
