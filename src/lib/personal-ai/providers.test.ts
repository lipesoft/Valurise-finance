import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyAIError, createSingle503RetryFetch, listProviderModels, type AIProvider } from "./providers";
import { GEMINI_SUPPORTED_MODELS, isGemini25FlashModel, isSupportedGeminiModel } from "./model-options";

describe("diagnóstico seguro dos provedores de IA", () => {
  it("classifica chave inválida sem devolver mensagem ou segredo do provedor", () => {
    const failure = classifyAIError(Object.assign(new Error("Provider request failed"), {
      statusCode: 400,
      responseBody: JSON.stringify({ error: { code: 400, message: "API key not valid; secret=nao-exibir", status: "INVALID_ARGUMENT", details: [{ reason: "API_KEY_INVALID" }] } }),
    }), "gemini", "gemini-2.5-flash-lite");
    expect(failure.category).toBe("INVALID_API_KEY");
    expect(failure.message).toContain("chave");
    expect(failure.message).not.toContain("nao-exibir");
    expect(failure.providerMessage).not.toContain("nao-exibir");
    expect(failure.providerCode).toBe("API_KEY_INVALID");
    expect(failure.httpStatus).toBe(400);
  });

  it("distingue modelo inválido, limite por minuto, cota diária, permissão e faturamento", () => {
    const model = classifyAIError(Object.assign(new Error("Provider request failed"), {
      statusCode: 404,
      responseBody: JSON.stringify({ error: { code: 404, message: "models/gemini-invalid is not found for generateContent", status: "NOT_FOUND" } }),
    }), "gemini", "gemini-invalid");
    const rateLimited = classifyAIError(Object.assign(new Error("Provider request failed"), {
      statusCode: 429,
      responseBody: JSON.stringify({ error: { code: 429, message: "Requests per minute limit exceeded", status: "RESOURCE_EXHAUSTED", details: [{ reason: "RATE_LIMIT_EXCEEDED", quotaId: "GenerateRequestsPerMinutePerProjectPerModel" }] } }),
    }), "gemini", "gemini-2.5-flash-lite");
    const quota = classifyAIError(Object.assign(new Error("Provider request failed"), {
      statusCode: 429,
      responseBody: JSON.stringify({ error: { code: 429, message: "You exceeded your current quota", status: "RESOURCE_EXHAUSTED", details: [{ "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel" }] }] } }),
    }), "gemini", "gemini-2.5-flash");
    const permission = classifyAIError(Object.assign(new Error("Provider request failed"), {
      statusCode: 403,
      responseBody: JSON.stringify({ error: { code: 403, message: "Gemini API has not been enabled", status: "PERMISSION_DENIED", details: [{ reason: "SERVICE_DISABLED" }] } }),
    }), "gemini", "gemini-2.5-flash-lite");
    const billing = classifyAIError(Object.assign(new Error("Provider request failed"), {
      statusCode: 400,
      responseBody: JSON.stringify({ error: { code: 400, message: "Billing is not enabled for this project. Please enable billing.", status: "FAILED_PRECONDITION" } }),
    }), "gemini", "gemini-2.5-flash-lite");
    const unavailable = classifyAIError(Object.assign(new Error("provider failure"), { statusCode: 503 }), "openai", "gpt-5-mini");
    expect(model.category).toBe("INVALID_MODEL");
    expect(rateLimited.category).toBe("RATE_LIMITED");
    expect(rateLimited.providerCode).toBe("RATE_LIMIT_EXCEEDED");
    expect(quota.category).toBe("QUOTA_EXCEEDED");
    expect(permission.category).toBe("PERMISSION_DENIED");
    expect(permission.providerCode).toBe("SERVICE_DISABLED");
    expect(billing.category).toBe("BILLING_REQUIRED");
    expect(unavailable.category).toBe("PROVIDER_UNAVAILABLE");
    expect(unavailable.retryable).toBe(true);
  });

  it("retorna somente modelos de texto presentes no catálogo autorizado", async () => {
    const payloadByProvider: Record<AIProvider, unknown> = {
      gemini: { models: [
        { name: "models/gemini-2.5-flash", displayName: "Gemini 2.5 Flash", supportedGenerationMethods: ["generateContent"] },
        { name: "models/gemini-2.5-flash-lite", displayName: "Gemini 2.5 Flash-Lite", supportedGenerationMethods: ["generateContent"] },
        { name: "models/gemini-3.8-flash", displayName: "Not approved", supportedGenerationMethods: ["generateContent"] },
        { name: "models/gemini-2.5-computer-use-preview-10-2025", displayName: "Computer use preview", supportedGenerationMethods: ["generateContent"] },
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
      { id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash-Lite", tier: "recommended" },
      { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", tier: "economical" },
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
  it("aceita exclusivamente os dois IDs Gemini 2.5 informados e prioriza Flash-Lite", () => {
    expect(GEMINI_SUPPORTED_MODELS.map((model) => model.id)).toEqual(["gemini-2.5-flash-lite", "gemini-2.5-flash"]);
    expect(isSupportedGeminiModel("gemini-2.5-flash-lite")).toBe(true);
    expect(isSupportedGeminiModel("gemini-2.5-flash")).toBe(true);
    expect(isSupportedGeminiModel("models/gemini-2.5-flash")).toBe(false);
    expect(isSupportedGeminiModel("gemini-2.5-flash-preview")).toBe(false);
    expect(isSupportedGeminiModel("gemini-3.8-flash")).toBe(false);
    expect(isGemini25FlashModel("gemini-2.5-flash")).toBe(true);
    expect(isGemini25FlashModel("gemini-2.5-flash-lite")).toBe(true);
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
