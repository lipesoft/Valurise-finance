import { describe, expect, it } from "vitest";
import { getValHealthCheckPrompt, VAL_HEALTH_CHECK_TOOL_NAME } from "./health-check";

describe("Val AI health check", () => {
  it("instrui o modelo a chamar a ferramenta antes de responder OK", () => {
    const prompt = getValHealthCheckPrompt(true);

    expect(prompt).toContain(VAL_HEALTH_CHECK_TOOL_NAME);
    expect(prompt).toMatch(/chame a ferramenta/i);
    expect(prompt).toMatch(/depois que ela retornar/i);
  });

  it("usa resposta mínima sem ferramentas quando a capacidade não é exigida", () => {
    expect(getValHealthCheckPrompt(false)).toBe("Responda somente: OK.");
  });
});
