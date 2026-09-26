import "server-only";

import { createGoogle } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import { isSupportedGeminiModel } from "./model-options";
import { AI_MODEL_ID_PATTERN, AI_PROVIDER_METADATA, type AIModelOption, type AIProvider } from "./provider-config";

export { AI_PROVIDERS, AI_PROVIDER_METADATA, type AIModelOption, type AIProvider } from "./provider-config";

const OPENAI_COMPATIBLE_BASE_URLS = {
  deepseek: "https://api.deepseek.com/v1",
  groq: "https://api.groq.com/openai/v1",
  openrouter: "https://openrouter.ai/api/v1",
} as const satisfies Record<Exclude<AIProvider, "openai" | "gemini">, string>;

export type AIErrorCategory =
  | "INVALID_API_KEY" | "INVALID_MODEL" | "MODEL_UNAVAILABLE" | "INVALID_REQUEST"
  | "RATE_LIMITED" | "QUOTA_EXCEEDED" | "INSUFFICIENT_BALANCE" | "BILLING_REQUIRED" | "PERMISSION_DENIED"
  | "REGION_RESTRICTED" | "CONTENT_BLOCKED" | "TIMEOUT" | "PROVIDER_OVERLOADED"
  | "PROVIDER_UNAVAILABLE" | "NETWORK_ERROR" | "MALFORMED_RESPONSE" | "TOOL_CALL_ERROR"
  | "TOOL_CALL_UNSUPPORTED" | "UNKNOWN_PROVIDER_ERROR";

const messages: Record<AIErrorCategory, (provider: string) => string> = {
  INVALID_API_KEY: (p) => `A chave da ${p} é inválida, foi revogada ou não tem permissão para usar a API.`,
  INVALID_MODEL: (p) => `O modelo selecionado não existe ou não está disponível para esta chave da ${p}. Atualize o catálogo e escolha outro modelo.`,
  MODEL_UNAVAILABLE: (p) => `Este modelo da ${p} não está disponível para sua conta ou região.`,
  INVALID_REQUEST: () => "O provedor não aceitou esta solicitação. Revise o modelo e tente novamente.",
  RATE_LIMITED: (p) => `A ${p} limitou temporariamente as solicitações. Aguarde um pouco antes de tentar novamente.`,
  QUOTA_EXCEEDED: (p) => `O limite de uso da ${p} foi atingido. Confira a cota e os limites do projeto do provedor.`,
  INSUFFICIENT_BALANCE: (p) => `O saldo da conta da ${p} é insuficiente para esta solicitação.`,
  BILLING_REQUIRED: (p) => `O provedor informou uma exigência de faturamento ou pré-condição da conta ${p}. Confira o projeto e o modelo selecionado.`,
  PERMISSION_DENIED: (p) => `A chave da ${p} não tem permissão para usar esta API ou este modelo. Confira o escopo da chave, a organização e o acesso ao modelo.`,
  REGION_RESTRICTED: (p) => `Este modelo da ${p} não está disponível na região configurada para sua conta.`,
  CONTENT_BLOCKED: () => "O provedor bloqueou a resposta por uma política de segurança. Reformule a pergunta e tente novamente.",
  TIMEOUT: () => "O provedor demorou demais para responder. Tente novamente em instantes.",
  PROVIDER_OVERLOADED: (p) => `A ${p} está temporariamente sobrecarregada. Tente novamente em instantes.`,
  PROVIDER_UNAVAILABLE: (p) => `O serviço da ${p} está temporariamente indisponível.`,
  NETWORK_ERROR: () => "Não foi possível alcançar o provedor. Verifique sua conexão e tente novamente.",
  MALFORMED_RESPONSE: (p) => `A ${p} respondeu em um formato inesperado. Tente novamente ou escolha outro modelo.`,
  TOOL_CALL_ERROR: () => "Não foi possível consultar os dados solicitados com segurança. Tente reformular a pergunta.",
  TOOL_CALL_UNSUPPORTED: (p) => `A conexão com ${p} funcionou, mas este modelo não oferece chamadas de ferramentas compatíveis com a Val. Escolha outro modelo e teste novamente.`,
  UNKNOWN_PROVIDER_ERROR: (p) => `A solicitação à ${p} falhou. Teste a conexão para ver um diagnóstico seguro.`,
};

export class AIProviderError extends Error {
  readonly provider: AIProvider;
  readonly model: string;
  readonly category: AIErrorCategory;
  readonly httpStatus: number | null;
  readonly providerCode: string | null;
  readonly providerMessage: string | null;
  readonly requestId: string | null;
  readonly retryable: boolean;

  constructor(args: {
    provider: AIProvider;
    model: string;
    category: AIErrorCategory;
    httpStatus?: number | null;
    providerCode?: string | null;
    providerMessage?: string | null;
    requestId?: string | null;
  }) {
    super(messages[args.category](AI_PROVIDER_METADATA[args.provider].label));
    this.name = "AIProviderError";
    this.provider = args.provider;
    this.model = args.model;
    this.category = args.category;
    this.httpStatus = args.httpStatus ?? null;
    this.providerCode = safeIdentifier(args.providerCode);
    this.providerMessage = safeProviderMessage(args.providerMessage);
    this.requestId = safeIdentifier(args.requestId);
    this.retryable = ["RATE_LIMITED", "PROVIDER_OVERLOADED", "PROVIDER_UNAVAILABLE", "NETWORK_ERROR", "TIMEOUT"].includes(args.category);
  }
}

function safeIdentifier(value: unknown) {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,100}$/.test(value) ? value : null;
}

function safeProviderMessage(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return null;
  return value.trim().replace(/AIza[0-9A-Za-z_-]{20,}/g, "[chave ocultada]")
    .replace(/(?:sk-(?:or-v1-|proj-)?|gsk_)[A-Za-z0-9_-]{16,}/gi, "[chave ocultada]")
    .replace(/(api[_ -]?key|secret|authorization|bearer|token)\s*[:=]\s*[^\s,;]+/gi, "$1=[ocultado]")
    .replace(/("(?:prompt|messages?|content|input|output)"\s*:\s*)"(?:\\.|[^"\\])*"/gi, '$1"[conteúdo ocultado]"')
    .replace(/https?:\/\/\S+/gi, "[endereço removido]")
    .replace(/\s+/g, " ").slice(0, 240);
}

function bodyDetails(body: unknown) {
  if (typeof body !== "string") return { text: "", code: "", status: "", reason: "", quota: "", providerHttpStatus: null as number | null };
  try {
    const parsed = JSON.parse(body) as { error?: string | { code?: string | number; type?: string; status?: string; message?: string; details?: unknown[] } };
    const error = parsed.error;
    if (typeof error === "string") return { text: error.slice(0, 1000), code: "", status: "", reason: "", quota: "", providerHttpStatus: null };
    if (!error || typeof error !== "object") return { text: "", code: "", status: "", reason: "", quota: "", providerHttpStatus: null };
    const details = Array.isArray(error.details) ? error.details : [];
    const detailValues = details.flatMap((detail) => {
      if (!detail || typeof detail !== "object") return [];
      const row = detail as Record<string, unknown>;
      const values = [row.reason, row.quotaId, row.quotaMetric, row.description, row.subject];
      const violations = Array.isArray(row.violations) ? row.violations : [];
      for (const violation of violations) {
        if (!violation || typeof violation !== "object") continue;
        const quota = violation as Record<string, unknown>;
        values.push(quota.quotaId, quota.quotaMetric, quota.description, quota.subject);
      }
      return values.filter((value): value is string => typeof value === "string");
    });
    const quota = detailValues.find((value) => /quota|perminute|perday|tokensper/i.test(value)) || "";
    const bodyStatus = Number(error.code || error.status);
    return {
      text: String(error?.message || error?.status || "").slice(0, 1000),
      code: String(typeof error.code === "string" || typeof error.code === "number" ? error.code : error.type || "").slice(0, 100),
      status: String(error.status || "").slice(0, 100),
      reason: String(detailValues.find((value) => /permission|api_key|rate|quota|billing|service_disabled/i.test(value)) || "").slice(0, 100),
      quota: quota.slice(0, 200),
      providerHttpStatus: Number.isInteger(bodyStatus) && bodyStatus >= 400 && bodyStatus <= 599 ? bodyStatus : null,
    };
  } catch {
    return { text: body.slice(0, 1000), code: "", status: "", reason: "", quota: "", providerHttpStatus: null };
  }
}

export function classifyAIError(error: unknown, provider: AIProvider, model: string): AIProviderError {
  if (error instanceof AIProviderError) return error;
  const value = (error || {}) as Record<string, unknown>;
  const rawStatus = Number(value.statusCode || value.status || 0);
  const transportStatus = Number.isFinite(rawStatus) && rawStatus > 0 ? rawStatus : null;
  const details = bodyDetails(value.responseBody);
  // Some OpenAI-compatible gateways return HTTP 200 while embedding an
  // upstream provider failure in the error envelope. Prefer that status only
  // when the transport itself succeeded; otherwise the real HTTP status wins.
  const status = transportStatus !== null && (transportStatus < 200 || transportStatus >= 300)
    ? transportStatus
    : details.providerHttpStatus ?? transportStatus;
  const rawCode = typeof value.code === "string" ? value.code : "";
  const code = details.reason || details.status || details.code || rawCode;
  const codeText = `${rawCode} ${details.code} ${details.status} ${details.reason} ${details.quota}`.toLowerCase();
  const message = `${String(value.message || "")} ${details.text} ${codeText}`.toLowerCase();
  const headers = value.responseHeaders as Record<string, string> | undefined;
  const headerEntries = Object.entries(headers || {}).map(([name, value]) => [name.toLowerCase(), value] as const);
  const requestId = headerEntries.find(([name]) => ["x-request-id", "request-id", "x-goog-request-id"].includes(name))?.[1];
  let category: AIErrorCategory = "UNKNOWN_PROVIDER_ERROR";

  if (/toolchoiceviolationerror/i.test(String(value.name || ""))
    || /tool.?call|tool.?use|function.?call|tool_choice/.test(message) && /unsupported|not supported|does not support|not available|no endpoints|did not contain a tool call/i.test(message)) category = "TOOL_CALL_UNSUPPORTED";
  else if (/aborterror|timed? ?out|timeout/.test(String(value.name || "").toLowerCase()) || /timed? ?out|timeout/.test(message)) category = "TIMEOUT";
  else if (/failed to fetch|network|econn|socket|dns/.test(message) || error instanceof TypeError && status === null) category = "NETWORK_ERROR";
  else if (/api[_ ]key[_ ]invalid|invalid[_ ]api[_ ]key|api key not valid|unauthorized/.test(message) || status === 401) category = "INVALID_API_KEY";
  else if (/insufficient[_ ]balance|balance[_ ]insufficient|insufficient.{0,20}(credit|fund)|not enough.{0,20}(credit|fund)/.test(message)) category = "INSUFFICIENT_BALANCE";
  else if (status === 402 && /billing|payment required|payment_required|precondition/.test(message)) category = "BILLING_REQUIRED";
  else if (status === 402) category = "INSUFFICIENT_BALANCE";
  else if (status !== 429 && /billing.{0,30}(required|disabled|not enabled|account|enable)|(?:enable|requires|required).{0,30}billing|payment required|payment_required|billing_disabled/.test(message)) category = "BILLING_REQUIRED";
  else if (/region|location.*not supported|not available in your country/.test(message)) category = "REGION_RESTRICTED";
  else if (/permission_denied|api_disabled|access_denied|forbidden/.test(codeText) || status === 403) category = "PERMISSION_DENIED";
  else if (status === 429 && /overload|capacity/.test(message)) category = "PROVIDER_OVERLOADED";
  else if (status === 429 && /per.?minute|requests_per_minute|tokens_per_minute|requestsperminute|tokensperminute|rate[_ ]limit|too_many_requests/.test(message)) category = "RATE_LIMITED";
  else if (/quota|resource_exhausted|exceeded.*limit|limit.*exceeded|per.?day/.test(message) && status === 429) category = "QUOTA_EXCEEDED";
  else if (status === 429) category = "RATE_LIMITED";
  else if (/model.*(not found|does not exist|unavailable|not support)|unsupported.*model/.test(message) || status === 404) category = status === 404 ? "INVALID_MODEL" : "MODEL_UNAVAILABLE";
  else if (status === 400 && /api key|key not valid/.test(message)) category = "INVALID_API_KEY";
  else if (status === 400 && /model|generation method|not found/.test(message)) category = "INVALID_MODEL";
  else if (status === 400) category = "INVALID_REQUEST";
  else if (status === 408) category = "TIMEOUT";
  else if (status && status >= 500) category = /overload|capacity/.test(message) ? "PROVIDER_OVERLOADED" : "PROVIDER_UNAVAILABLE";

  return new AIProviderError({ provider, model, category, httpStatus: status, providerCode: code, providerMessage: details.text || undefined, requestId });
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
  switch (provider) {
    case "openai":
      return createOpenAI({ apiKey }).chat(model);
    case "gemini":
      return createGoogle({ apiKey, fetch: createSingle503RetryFetch() })(model);
    case "deepseek":
    case "groq":
      return createOpenAICompatible({ name: provider, apiKey, baseURL: OPENAI_COMPATIBLE_BASE_URLS[provider] })(model);
    case "openrouter":
      return createOpenAICompatible({
        name: provider,
        apiKey,
        baseURL: OPENAI_COMPATIBLE_BASE_URLS.openrouter,
        headers: openRouterHeaders(),
      })(model);
    default: {
      const unsupportedProvider: never = provider;
      throw new Error(`Unsupported AI provider: ${unsupportedProvider}`);
    }
  }
}

function openRouterHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "X-OpenRouter-Title": "Valurise" };
  const configuredUrl = process.env.NEXT_PUBLIC_SITE_URL || process.env.NEXT_PUBLIC_APP_URL;
  if (configuredUrl) {
    try {
      const url = new URL(configuredUrl);
      if (url.protocol === "https:" && !url.username && !url.password) headers["HTTP-Referer"] = url.origin;
    } catch {
      // Attribution headers are optional; an invalid or absent site URL is simply omitted.
    }
  }
  return headers;
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
      headers: provider === "gemini"
        ? { "x-goog-api-key": apiKey }
        : { Authorization: `Bearer ${apiKey}`, ...(provider === "openrouter" ? openRouterHeaders() : {}) },
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

function modelTier(provider: AIProvider, id: string, free = false): AIModelOption["tier"] {
  const value = id.toLowerCase();
  if (value === AI_PROVIDER_METADATA[provider].defaultModel || (provider === "openrouter" && value === "openrouter/free")) return "recommended";
  if (free) return "economical";
  if (provider === "gemini" && value === "gemini-2.5-flash") return "economical";
  if (/mini|nano|flash-lite|flash$/.test(value)) return "economical";
  if (/pro|reason|o[134]/.test(value)) return "advanced";
  return "other";
}

function isZeroPrice(value: unknown) {
  return (typeof value === "string" || typeof value === "number") && Number.isFinite(Number(value)) && Number(value) === 0;
}

function isClearlyNonChatModel(id: string, label: string) {
  return /(speech|whisper|tts|transcri|audio|moderation|prompt.?guard|safeguard|embedding|embed)/i.test(`${id} ${label}`);
}

function hasTextOutput(row: Record<string, unknown>) {
  const architecture = row.architecture;
  if (!architecture || typeof architecture !== "object") return true;
  const outputModalities = (architecture as Record<string, unknown>).output_modalities;
  return !Array.isArray(outputModalities) || outputModalities.includes("text");
}

export async function listProviderModels(provider: AIProvider, apiKey: string, signal?: AbortSignal): Promise<AIModelOption[]> {
  const baseModel = "catalog";
  let payload: Record<string, unknown>;
  if (provider === "openai") payload = await fetchJSON(provider, baseModel, "https://api.openai.com/v1/models", apiKey, signal);
  else if (provider === "gemini") payload = await fetchJSON(provider, baseModel, "https://generativelanguage.googleapis.com/v1beta/models", apiKey, signal);
  else if (provider === "deepseek") payload = await fetchJSON(provider, baseModel, "https://api.deepseek.com/models", apiKey, signal);
  else if (provider === "groq") payload = await fetchJSON(provider, baseModel, "https://api.groq.com/openai/v1/models", apiKey, signal);
  else payload = await fetchJSON(provider, baseModel, "https://openrouter.ai/api/v1/models?output_modalities=text", apiKey, signal);

  const rows = Array.isArray(payload.data) ? payload.data : Array.isArray(payload.models) ? payload.models : [];
  const models = rows.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    const rawId = String(row.id || row.name || "");
    const id = provider === "gemini" ? rawId.replace(/^models\//, "") : rawId;
    const supported = row.supportedGenerationMethods;
    const label = String(row.displayName || row.name || id).replace(/^models\//, "").slice(0, 120);
    const active = typeof row.active !== "boolean" || row.active;
    const textModel = provider === "gemini"
      ? Array.isArray(supported) && supported.includes("generateContent") && isSupportedGeminiModel(id)
      : provider === "openai"
        ? /^(gpt-|chatgpt-|o[134](?:-|$))/i.test(id) && !/(embedding|whisper|tts|transcri|image|realtime|moderation|search-preview)/i.test(id)
        : provider === "deepseek"
          ? /^deepseek-/i.test(id) && !isClearlyNonChatModel(id, label)
          : (provider === "groq" || provider === "openrouter") && active && hasTextOutput(row) && !isClearlyNonChatModel(id, label);
    if (!textModel || !AI_MODEL_ID_PATTERN.test(id)) return [];
    const pricing = row.pricing && typeof row.pricing === "object" ? row.pricing as Record<string, unknown> : {};
    const free = provider === "openrouter" && (id.endsWith(":free") || id === "openrouter/free"
      || isZeroPrice(pricing.prompt) && isZeroPrice(pricing.completion));
    return [{
      id,
      label: provider === "openrouter" && id === "openrouter/free" ? "OpenRouter Free · Recomendado" : label,
      tier: modelTier(provider, id, free),
      ...(provider === "openrouter" ? { free } : {}),
      provider,
    } satisfies AIModelOption];
  });
  const uniqueModels = [...new Map(models.map((item) => [item.id, item])).values()];
  if (provider === "openrouter" && !uniqueModels.some((item) => item.id === "openrouter/free")) {
    uniqueModels.push({ id: "openrouter/free", label: "OpenRouter Free · Recomendado", tier: "recommended", free: true, provider });
  }
  return uniqueModels.sort((a, b) => {
    if (provider === "openrouter") {
      const priority = (item: AIModelOption) => item.id === "openrouter/free" ? 0 : item.free ? 1 : 2;
      const freeDifference = priority(a) - priority(b);
      if (freeDifference) return freeDifference;
    }
    if (provider === "gemini") {
      const priority = (id: string) => id === "gemini-2.5-flash-lite" ? 0 : id === "gemini-2.5-flash" ? 1 : 2;
      const difference = priority(a.id) - priority(b.id);
      if (difference) return difference;
    }
    const order = { recommended: 0, economical: 1, advanced: 2, other: 3 };
    return order[a.tier] - order[b.tier] || a.label.localeCompare(b.label);
  }).slice(0, 120);
}
