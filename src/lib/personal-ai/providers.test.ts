import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyAIError, createSingle503RetryFetch, isGemini3Model, listProviderModels, type AIProvider } from "./providers";

describe("diagnóstico seguro dos provedores de IA", () => {
  it("classifica chave inválida sem devolver mensagem ou segredo do provedor", () => {
    const failure = classifyAIError(Object.assign(new Error("API key not valid; secret=nao-exibir"), { statusCode: 401 }), "gemini", "gemini-3.8-flash");
    expect(failure.category).toBe("INVALID_API_KEY");
    expect(failure.message).toContain("chave");
    expect(failure.message).not.toContain("nao-exibir");
  });

  it("distingue modelo inválido, cota e indisponibilidade", () => {
    const model = classifyAIError(Object.assign(new Error("model not found"), { statusCode: 404 }), "deepseek", "deepseek-retired");
    const quota = classifyAIError(Object.assign(new Error("RESOURCE_EXHAUSTED quota exceeded"), { statusCode: 429 }), "gemini", "gemini-3.8-flash");
    const unavailable = classifyAIError(Object.assign(new Error("provider failure"), { statusCode: 503 }), "openai", "gpt-5-mini");
    expect(model.category).toBe("INVALID_MODEL");
    expect(quota.category).toBe("QUOTA_EXCEEDED");
    expect(unavailable.category).toBe("PROVIDER_UNAVAILABLE");
    expect(unavailable.retryable).toBe(true);
  });

  it("retorna somente modelos de texto presentes no catálogo autorizado", async () => {
    const payloadByProvider: Record<AIProvider, unknown> = {
      gemini: { models: [
        { name: "models/gemini-3.8-flash", displayName: "Gemini 3.8 Flash", supportedGenerationMethods: ["generateContent"] },
        { name: "models/gemini-2.5-computer-use-preview-10-2025", displayName: "Computer use preview", supportedGenerationMethods: ["generateContent"] },
        { name: "models/gemini-3.8-flash-preview", displayName: "Flash preview", supportedGenerationMethods: ["generateContent"] },
        { name: "models/gemini-image", displayName: "Image generator", supportedGenerationMethods: ["generateImage"] },
      ] },
      deepseek: { data: [{ id: "deepseek-v4-flash" }, { id: "deepseek-v4-pro" }] },
      openai: { data: [{ id: "gpt-5-mini" }, { id: "text-embedding-3-small" }] },
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const provider = url.includes("googleapis") ? "gemini" : url.includes("deepseek") ? "deepseek" : "openai";
      return new Response(JSON.stringify(payloadByProvider[provider]), { status: 200, headers: { "content-type": "application/json" } });
    }));

    await expect(listProviderModels("gemini", "fake-key")).resolves.toEqual([
      { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", tier: "recommended" },
    ]);
    await expect(listProviderModels("deepseek", "fake-key")).resolves.toMatchObject([
      { id: "deepseek-v4-flash", tier: "recommended" },
      { id: "deepseek-v4-pro", tier: "advanced" },
    ]);
    await expect(listProviderModels("openai", "fake-key")).resolves.toEqual([
      { id: "gpt-5-mini", label: "gpt-5-mini", tier: "recommended" },
    ]);
  });
});

describe("resiliência controlada do Gemini", () => {
  it("identifica modelos Gemini 3 sem alterar outros modelos", () => {
    expect(isGemini3Model("gemini-3.8-flash")).toBe(true);
    expect(isGemini3Model("gemini-3-pro-preview")).toBe(true);
    expect(isGemini3Model("gemini-2.5-flash")).toBe(false);
  });

  it("repete uma única resposta 503 e retorna a segunda resposta", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("temporário", { status: 503 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const resilientFetch = createSingle503RetryFetch(fetchMock as typeof fetch, 0);

    const response = await resilientFetch("https://provider.invalid/generate", { method: "POST", body: "{}" });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("não repete erro de cota 429", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("quota", { status: 429 }));
    const resilientFetch = createSingle503RetryFetch(fetchMock as typeof fetch, 0);

    const response = await resilientFetch("https://provider.invalid/generate", { method: "POST", body: "{}" });

    expect(response.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

afterEach(() => vi.unstubAllGlobals());
