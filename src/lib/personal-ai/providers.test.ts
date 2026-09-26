import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyAIError, createSingle503RetryFetch, listProviderModels, type AIProvider } from "./providers";
import { GEMINI_SUPPORTED_MODELS, isGemini25FlashModel, isSupportedGeminiModel } from "./model-options";
import { AI_MODEL_ID_PATTERN, isSafeAIModelId } from "./provider-config";

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

  it("classifica erros comuns de Groq/OpenRouter e separa incompatibilidade de ferramentas", () => {
    const invalidKey = classifyAIError(Object.assign(new Error("Provider request failed"), { statusCode: 401 }), "groq", "openai/gpt-oss-20b");
    const insufficient = classifyAIError(Object.assign(new Error("Provider request failed"), {
      statusCode: 402,
      responseBody: JSON.stringify({ error: { message: "Insufficient credits for this request", code: 402 } }),
    }), "openrouter", "openrouter/free");
    const rateLimit = classifyAIError(Object.assign(new Error("Provider request failed"), {
      statusCode: 429,
      responseBody: JSON.stringify({ error: { message: "Rate limit exceeded", code: 429 } }),
    }), "openrouter", "qwen/model:free");
    const overloaded = classifyAIError(Object.assign(new Error("Provider overloaded"), { statusCode: 503 }), "groq", "openai/gpt-oss-20b");
    const toolsUnsupported = classifyAIError(Object.assign(new Error("No endpoints found that support tool use"), { statusCode: 404 }), "openrouter", "model/without-tools");

    expect(invalidKey.category).toBe("INVALID_API_KEY");
    expect(insufficient.category).toBe("INSUFFICIENT_BALANCE");
    expect(rateLimit.category).toBe("RATE_LIMITED");
    expect(overloaded.category).toBe("PROVIDER_OVERLOADED");
    expect(toolsUnsupported.category).toBe("TOOL_CALL_UNSUPPORTED");
  });

  it("reconhece indisponibilidade do upstream quando um gateway devolve HTTP 200", () => {
    const upstreamFailure = classifyAIError(Object.assign(new Error("Provider request failed"), {
      statusCode: 200,
      responseBody: JSON.stringify({ error: { code: 503, message: "Upstream provider temporarily unavailable" } }),
    }), "openrouter", "openrouter/free");

    expect(upstreamFailure.category).toBe("PROVIDER_UNAVAILABLE");
    expect(upstreamFailure.httpStatus).toBe(503);
    expect(upstreamFailure.providerCode).toBe("503");
  });

  it("sanitiza chaves OpenRouter/Groq e valores de contexto em detalhes do provedor", () => {
    const failure = classifyAIError(Object.assign(new Error("Provider request failed"), {
      statusCode: 400,
      responseBody: JSON.stringify({ error: { message: 'invalid request sk-or-v1-123456789012345678901234 "prompt":"saldo secreto"' } }),
    }), "openrouter", "openai/model");
    expect(failure.providerMessage).not.toContain("sk-or-v1-");
    expect(failure.providerMessage).not.toContain("saldo secreto");
    expect(failure.message).not.toContain("sk-or-v1-");
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
      groq: { data: [
        { id: "openai/gpt-oss-20b", active: true },
        { id: "qwen/qwen3-32b", active: true },
        { id: "whisper-large-v3", active: true },
        { id: "meta-llama/llama-prompt-guard-2-86m", active: true },
        { id: "inactive/model", active: false },
      ] },
      openrouter: { data: [
        { id: "anthropic/paid-model", name: "Paid model", pricing: { prompt: "0.0001", completion: "0.0002" } },
        { id: "qwen/model:free", name: "Qwen Free", pricing: { prompt: "0", completion: "0" } },
        { id: "provider/zero-priced", name: "Zero-priced model", pricing: { prompt: 0, completion: 0 } },
        { id: "openrouter/free", name: "Free router", pricing: { prompt: "0", completion: "0" } },
        { id: "vendor/audio-only", name: "Audio model", architecture: { output_modalities: ["audio"] }, pricing: { prompt: "0", completion: "0" } },
      ] },
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const provider = url.includes("googleapis") ? "gemini"
        : url.includes("deepseek") ? "deepseek"
          : url.includes("groq") ? "groq"
            : url.includes("openrouter") ? "openrouter"
              : "openai";
      return new Response(JSON.stringify(payloadByProvider[provider]), { status: 200, headers: { "content-type": "application/json" } });
    }));

    await expect(listProviderModels("gemini", "fake-key")).resolves.toEqual([
      { id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash-Lite", tier: "recommended", provider: "gemini" },
      { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", tier: "economical", provider: "gemini" },
    ]);
    await expect(listProviderModels("deepseek", "fake-key")).resolves.toMatchObject([
      { id: "deepseek-v4-flash", tier: "recommended" },
      { id: "deepseek-v4-pro", tier: "advanced" },
    ]);
    await expect(listProviderModels("openai", "fake-key")).resolves.toEqual([
      { id: "gpt-5-mini", label: "gpt-5-mini", tier: "recommended", provider: "openai" },
    ]);

    const groqModels = await listProviderModels("groq", "fake-key");
    expect(groqModels.map((item) => item.id)).toEqual(["openai/gpt-oss-20b", "qwen/qwen3-32b"]);
    expect(groqModels[0]).toMatchObject({ id: "openai/gpt-oss-20b", provider: "groq", tier: "recommended" });
    expect(fetch).toHaveBeenCalledWith("https://api.groq.com/openai/v1/models", expect.objectContaining({
      headers: { Authorization: "Bearer fake-key" },
    }));

    const openRouterModels = await listProviderModels("openrouter", "fake-key");
    expect(openRouterModels.map((item) => item.id)).toEqual([
      "openrouter/free",
      "qwen/model:free",
      "provider/zero-priced",
      "anthropic/paid-model",
    ]);
    expect(openRouterModels[0]).toMatchObject({ id: "openrouter/free", label: "OpenRouter Free · Recomendado", free: true, tier: "recommended" });
    expect(openRouterModels[1].free).toBe(true);
    expect(openRouterModels[2].free).toBe(true);
    expect(fetch).toHaveBeenCalledWith("https://openrouter.ai/api/v1/models?output_modalities=text", expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer fake-key", "X-OpenRouter-Title": "Valurise" }),
    }));
  });

  it("aceita IDs de modelos com barra e dois-pontos sem aceitar separadores perigosos", () => {
    expect(AI_MODEL_ID_PATTERN.test("openai/gpt-oss-20b")).toBe(true);
    expect(isSafeAIModelId("qwen/model:free")).toBe(true);
    expect(isSafeAIModelId("openrouter/free")).toBe(true);
    expect(isSafeAIModelId("model/name?key=bad")).toBe(false);
    expect(isSafeAIModelId("../arbitrary-host")).toBe(false);
    expect(isSafeAIModelId("vendor/../arbitrary-host")).toBe(false);
    expect(isSafeAIModelId("vendor//model")).toBe(false);
    expect(isSafeAIModelId("a".repeat(101))).toBe(false);
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
