import "server-only";

import { createGoogle } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

export const AI_PROVIDERS = ["openai", "gemini", "deepseek"] as const;
export type AIProvider = (typeof AI_PROVIDERS)[number];

export type AIErrorCategory =
  | "INVALID_API_KEY" | "INVALID_MODEL" | "MODEL_UNAVAILABLE" | "INVALID_REQUEST"
  | "RATE_LIMITED" | "QUOTA_EXCEEDED" | "INSUFFICIENT_BALANCE" | "BILLING_REQUIRED"
  | "REGION_RESTRICTED" | "CONTENT_BLOCKED" | "TIMEOUT" | "PROVIDER_OVERLOADED"
  | "PROVIDER_UNAVAILABLE" | "NETWORK_ERROR" | "MALFORMED_RESPONSE" | "TOOL_CALL_ERROR"
  | "UNKNOWN_PROVIDER_ERROR";

const providerNames: Record<AIProvider, string> = {
  openai: "OpenAI", gemini: "Gemini", deepseek: "DeepSeek",
};

const messages: Record<AIErrorCategory, (provider: string) => string> = {
  INVALID_API_KEY: (p) => `A chave da ${p} é inválida, foi revogada ou não tem permissão para usar a API.`,
  INVALID_MODEL: (p) => `O modelo selecionado não existe ou não está disponível para esta chave da ${p}. Atualize o catálogo e escolha outro modelo.`,
  MODEL_UNAVAILABLE: (p) => `Este modelo da ${p} não está disponível para sua conta ou região.`,
  INVALID_REQUEST: () => "O provedor não aceitou esta solicitação. Revise o modelo e tente novamente.",
  RATE_LIMITED: (p) => `A ${p} limitou temporariamente as solicitações. Aguarde um pouco antes de tentar novamente.`,
  QUOTA_EXCEEDED: (p) => `O limite de uso da ${p} foi atingido. Confira a cota e os limites do projeto do provedor.`,
  INSUFFICIENT_BALANCE: (p) => `O saldo da conta da ${p} é insuficiente para esta solicitação.`,
  BILLING_REQUIRED: (p) => `A conta ou o projeto da ${p} precisa de faturamento ativo para usar este modelo.`,
  REGION_RESTRICTED: (p) => `Este modelo da ${p} não está disponível na região configurada para sua conta.`,
  CONTENT_BLOCKED: () => "O provedor bloqueou a resposta por uma política de segurança. Reformule a pergunta e tente novamente.",
  TIMEOUT: () => "O provedor demorou demais para responder. Tente novamente em instantes.",
  PROVIDER_OVERLOADED: (p) => `A ${p} está temporariamente sobrecarregada. Tente novamente em instantes.`,
  PROVIDER_UNAVAILABLE: (p) => `O serviço da ${p} está temporariamente indisponível.`,
  NETWORK_ERROR: () => "Não foi possível alcançar o provedor. Verifique sua conexão e tente novamente.",
  MALFORMED_RESPONSE: (p) => `A ${p} respondeu em um formato inesperado. Tente novamente ou escolha outro modelo.`,
  TOOL_CALL_ERROR: () => "Não foi possível consultar os dados solicitados com segurança. Tente reformular a pergunta.",
  UNKNOWN_PROVIDER_ERROR: (p) => `A solicitação à ${p} falhou. Teste a conexão para ver um diagnóstico seguro.`,
};

export class AIProviderError extends Error {
  readonly provider: AIProvider;
  readonly model: string;
  readonly category: AIErrorCategory;
  readonly httpStatus: number | null;
  readonly providerCode: string | null;
  readonly requestId: string | null;
  readonly retryable: boolean;

  constructor(args: {
    provider: AIProvider;
    model: string;
    category: AIErrorCategory;
    httpStatus?: number | null;
    providerCode?: string | null;
    requestId?: string | null;
  }) {
    super(messages[args.category](providerNames[args.provider]));
    this.name = "AIProviderError";
    this.provider = args.provider;
    this.model = args.model;
    this.category = args.category;
    this.httpStatus = args.httpStatus ?? null;
    this.providerCode = safeIdentifier(args.providerCode);
    this.requestId = safeIdentifier(args.requestId);
    this.retryable = ["RATE_LIMITED", "PROVIDER_OVERLOADED", "PROVIDER_UNAVAILABLE", "NETWORK_ERROR", "TIMEOUT"].includes(args.category);
  }
}

function safeIdentifier(value: unknown) {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,100}$/.test(value) ? value : null;
}

function bodyDetails(body: unknown) {
  if (typeof body !== "string") return { text: "", code: "" };
  try {
    const parsed = JSON.parse(body) as { error?: string | { code?: string; type?: string; status?: string; message?: string } };
    const error = parsed.error;
    if (typeof error === "string") return { text: error.slice(0, 1000), code: "" };
    return {
      text: String(error?.message || error?.status || "").slice(0, 1000),
      code: String(error?.code || error?.type || error?.status || "").slice(0, 100),
    };
  } catch {
    return { text: body.slice(0, 1000), code: "" };
  }
}

export function classifyAIError(error: unknown, provider: AIProvider, model: string): AIProviderError {
  if (error instanceof AIProviderError) return error;
  const value = (error || {}) as Record<string, unknown>;
  const status = Number(value.statusCode || value.status || 0) || null;
  const details = bodyDetails(value.responseBody);
  const code = String(value.code || details.code || "");
  const message = `${String(value.message || "")} ${details.text} ${code}`.toLowerCase();
  const headers = value.responseHeaders as Record<string, string> | undefined;
  const headerEntries = Object.entries(headers || {}).map(([name, value]) => [name.toLowerCase(), value] as const);
  const requestId = headerEntries.find(([name]) => ["x-request-id", "request-id", "x-goog-request-id"].includes(name))?.[1];
  let category: AIErrorCategory = "UNKNOWN_PROVIDER_ERROR";

  if (/aborterror|timed? ?out|timeout/.test(String(value.name || "").toLowerCase()) || /timed? ?out|timeout/.test(message)) category = "TIMEOUT";
  else if (/failed to fetch|network|econn|socket|dns/.test(message) || error instanceof TypeError && status === null) category = "NETWORK_ERROR";
  else if (status === 401 || /invalid[_ ]api[_ ]key|api key not valid|unauthorized/.test(message)) category = "INVALID_API_KEY";
  else if (/insufficient[_ ]balance|balance[_ ]insufficient/.test(message) || status === 402) category = "INSUFFICIENT_BALANCE";
  else if (/billing|required.*billing|billing.*required|payment required/.test(message)) category = "BILLING_REQUIRED";
  else if (/region|location.*not supported|not available in your country/.test(message)) category = "REGION_RESTRICTED";
  else if (status === 429 && /overload|capacity/.test(message)) category = "PROVIDER_OVERLOADED";
  else if (/quota|resource_exhausted|exceeded.*limit|limit.*exceeded/.test(message) && status === 429) category = "QUOTA_EXCEEDED";
  else if (status === 429) category = "RATE_LIMITED";
  else if (/model.*(not found|does not exist|unavailable|not support)|unsupported.*model/.test(message) || status === 404) category = status === 404 ? "INVALID_MODEL" : "MODEL_UNAVAILABLE";
  else if (status === 400 && /api key|key not valid/.test(message)) category = "INVALID_API_KEY";
  else if (status === 400 && /model|generation method|not found/.test(message)) category = "INVALID_MODEL";
  else if (status === 400) category = "INVALID_REQUEST";
  else if (status === 403) category = "MODEL_UNAVAILABLE";
  else if (status === 408) category = "TIMEOUT";
  else if (status && status >= 500) category = /overload|capacity/.test(message) ? "PROVIDER_OVERLOADED" : "PROVIDER_UNAVAILABLE";

  return new AIProviderError({ provider, model, category, httpStatus: status, providerCode: code, requestId });
}

export function logAIError(error: AIProviderError, latencyMs: number) {
  // Intentionally log diagnostics only: never provider response bodies, prompts, keys, or finance data.
  console.error("Val AI provider failure", JSON.stringify({
    provider: error.provider,
    model: error.model,
    category: error.category,
    httpStatus: error.httpStatus,
    providerCode: error.providerCode,
    requestId: error.requestId,
    retryable: error.retryable,
    latencyMs,
    timestamp: new Date().toISOString(),
  }));
}

export function createProviderModel(provider: AIProvider, apiKey: string, model: string): LanguageModel {
  if (provider === "openai") return createOpenAI({ apiKey }).chat(model);
  if (provider === "gemini") return createGoogle({ apiKey, fetch: createSingle503RetryFetch() })(model);
  return createOpenAICompatible({
    name: "deepseek",
    apiKey,
    baseURL: "https://api.deepseek.com/v1",
  })(model);
}

export function isGemini3Model(model: string) {
  return /^gemini-3(?:\.|-)/i.test(model);
}

/** Retries one Gemini 503 only. Billing, quota and invalid-model errors are never replayed. */
export function createSingle503RetryFetch(fetchImplementation: typeof fetch = fetch, retryDelayMs = 500): typeof fetch {
  return async (input, init) => {
    const retryInput = input instanceof Request ? input.clone() : input;
    const signal = init?.signal || (input instanceof Request ? input.signal : undefined);
    const firstResponse = await fetchImplementation(input, init);
    if (firstResponse.status !== 503 || signal?.aborted) return firstResponse;

    await new Promise<void>((resolve) => setTimeout(resolve, retryDelayMs));
    if (signal?.aborted) return firstResponse;
    await firstResponse.body?.cancel().catch(() => undefined);
    return fetchImplementation(retryInput, init);
  };
}

async function fetchJSON(provider: AIProvider, model: string, url: string, apiKey: string, signal?: AbortSignal) {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      signal,
      headers: provider === "gemini" ? { "x-goog-api-key": apiKey } : { Authorization: `Bearer ${apiKey}` },
      cache: "no-store",
    });
  } catch (error) {
    throw classifyAIError(error, provider, model);
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const wrapped = Object.assign(new Error("Provider catalog request failed"), {
      statusCode: response.status,
      responseBody: text,
      responseHeaders: Object.fromEntries(response.headers.entries()),
    });
    throw classifyAIError(wrapped, provider, model);
  }
  try { return await response.json() as Record<string, unknown>; }
  catch { throw new AIProviderError({ provider, model, category: "MALFORMED_RESPONSE", httpStatus: response.status }); }
}

export type AIModelOption = { id: string; label: string; tier: "recommended" | "economical" | "advanced" | "other" };

function modelTier(provider: AIProvider, id: string): AIModelOption["tier"] {
  const value = id.toLowerCase();
  if ((provider === "gemini" && value === "gemini-3.8-flash") || (provider === "deepseek" && value === "deepseek-v4-flash") || (provider === "openai" && value === "gpt-5-mini")) return "recommended";
  if (/mini|nano|flash-lite|flash$/.test(value)) return "economical";
  if (/pro|reason|o[134]/.test(value)) return "advanced";
  return "other";
}

export async function listProviderModels(provider: AIProvider, apiKey: string, signal?: AbortSignal): Promise<AIModelOption[]> {
  const baseModel = "catalog";
  let payload: Record<string, unknown>;
  if (provider === "openai") payload = await fetchJSON(provider, baseModel, "https://api.openai.com/v1/models", apiKey, signal);
  else if (provider === "gemini") payload = await fetchJSON(provider, baseModel, "https://generativelanguage.googleapis.com/v1beta/models", apiKey, signal);
  else payload = await fetchJSON(provider, baseModel, "https://api.deepseek.com/models", apiKey, signal);

  const rows = Array.isArray(payload.data) ? payload.data : Array.isArray(payload.models) ? payload.models : [];
  const models = rows.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    const rawId = String(row.id || row.name || "");
    const id = provider === "gemini" ? rawId.replace(/^models\//, "") : rawId;
    const supported = row.supportedGenerationMethods;
    const textModel = provider === "gemini"
      ? Array.isArray(supported) && supported.includes("generateContent")
        && !/(preview|computer-use|image|audio|tts|live|deep-research|robotics)/i.test(id)
      : /^(gpt-|chatgpt-|o[134](?:-|$)|deepseek-)/i.test(id)
        && !/(embedding|whisper|tts|transcri|image|realtime|moderation|search-preview)/i.test(id);
    if (!textModel || !/^[A-Za-z0-9._:-]{2,100}$/.test(id)) return [];
    const label = String(row.displayName || row.name || id).replace(/^models\//, "").slice(0, 120);
    return [{ id, label, tier: modelTier(provider, id) } as AIModelOption];
  });
  return [...new Map(models.map((item) => [item.id, item])).values()].sort((a, b) => {
    const order = { recommended: 0, economical: 1, advanced: 2, other: 3 };
    return order[a.tier] - order[b.tier] || a.label.localeCompare(b.label);
  }).slice(0, 120);
}
