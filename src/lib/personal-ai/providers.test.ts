import { beforeEach, describe, expect, it, vi } from "vitest";

const sdkMock = vi.hoisted(() => ({
  createOpenAICompatible: vi.fn((config: Record<string, string>) => (model: string) => ({ config, model })),
}));
vi.mock("@ai-sdk/openai-compatible", () => sdkMock);

import { classifyAIError, createProviderModel } from "./providers";
import { AI_PROVIDERS, isAIProvider } from "./provider-config";

describe("provider central da Val", () => {
  beforeEach(() => sdkMock.createOpenAICompatible.mockClear());

  it("expõe DeepSeek como único provider configurável", () => {
    expect(AI_PROVIDERS).toEqual(["deepseek"]);
    expect(isAIProvider("deepseek")).toBe(true);
    expect(isAIProvider("groq")).toBe(false);
    expect(isAIProvider("openrouter")).toBe(false);
    expect(isAIProvider("openai")).toBe(false);
    expect(isAIProvider("gemini")).toBe(false);
  });

  it("cria chamadas somente para o endpoint central DeepSeek", () => {
    expect(createProviderModel("deepseek", "central-key", "deepseek-chat")).toMatchObject({ model: "deepseek-chat" });
    expect(sdkMock.createOpenAICompatible).toHaveBeenCalledWith({
      name: "deepseek",
      apiKey: "central-key",
      baseURL: "https://api.deepseek.com",
    });
  });

  it.each(["groq", "openrouter", "openai", "gemini"])("recusa %s antes de criar uma chamada", (provider) => {
    expect(() => createProviderModel(provider, "attacker-key", "paid-model")).toThrow("Somente o provider central DeepSeek está habilitado.");
    expect(sdkMock.createOpenAICompatible).not.toHaveBeenCalled();
  });

  it("classifica falhas da DeepSeek e não vaza conteúdo técnico sensível", () => {
    const invalidKey = classifyAIError(Object.assign(new Error("request rejected"), { statusCode: 401 }), "deepseek", "deepseek-chat");
    const quota = classifyAIError(Object.assign(new Error("Provider request failed"), {
      statusCode: 429,
      responseBody: JSON.stringify({ error: { message: "Requests per minute limit exceeded" } }),
    }), "deepseek", "deepseek-chat");
    const insufficient = classifyAIError(Object.assign(new Error("Provider request failed"), { statusCode: 402 }), "deepseek", "deepseek-chat");
    const unavailable = classifyAIError(Object.assign(new Error("Provider unavailable"), { statusCode: 503 }), "deepseek", "deepseek-chat");
    const sensitive = classifyAIError(Object.assign(new Error("Provider request failed"), {
      statusCode: 400,
      responseBody: JSON.stringify({ error: { message: 'invalid request sk-123456789012345678901234 "prompt":"saldo secreto"' } }),
    }), "deepseek", "deepseek-chat");

    expect(invalidKey.category).toBe("INVALID_API_KEY");
    expect(quota.category).toBe("RATE_LIMITED");
    expect(insufficient.category).toBe("INSUFFICIENT_BALANCE");
    expect(unavailable.category).toBe("PROVIDER_UNAVAILABLE");
    expect(unavailable.retryable).toBe(true);
    expect(sensitive.providerMessage).not.toContain("sk-");
    expect(sensitive.providerMessage).not.toContain("saldo secreto");
  });

  it("preserva metadados seguros de cota e controla o retry informado pelo provider", () => {
    const fromHeader = classifyAIError(Object.assign(new Error("request failed"), {
      statusCode: 429,
      responseHeaders: { "retry-after": "9.5", authorization: "Bearer segredo" },
    }), "deepseek", "deepseek-chat");
    const fromMessage = classifyAIError(Object.assign(new Error("request failed"), {
      statusCode: 429,
      responseBody: JSON.stringify({ error: { message: "Rate limit reached. Please try again in 9.257142857s." } }),
    }), "deepseek", "deepseek-chat");

    expect(fromHeader.retryAfterMs).toBe(9500);
    expect(fromHeader.quotaHeaders).toEqual({ "retry-after": "9.5" });
    expect(JSON.stringify(fromHeader.quotaHeaders)).not.toContain("segredo");
    expect(fromMessage.retryAfterMs).toBe(9257);
    expect(fromMessage.quotaHeaders["retry-after"]).toBe("9.3");
  });
});
