import "server-only";

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import { AI_PROVIDER_METADATA, type AIProvider } from "./provider-config";

export { AI_PROVIDERS, AI_PROVIDER_METADATA, type AIProvider } from "./provider-config";

export type AIErrorCategory =
  | "INVALID_API_KEY" | "INVALID_MODEL" | "MODEL_UNAVAILABLE" | "INVALID_REQUEST"
  | "RATE_LIMITED" | "QUOTA_EXCEEDED" | "INSUFFICIENT_BALANCE" | "BILLING_REQUIRED" | "PERMISSION_DENIED"
  | "REGION_RESTRICTED" | "CONTENT_BLOCKED" | "TIMEOUT" | "PROVIDER_OVERLOADED"
  | "PROVIDER_UNAVAILABLE" | "NETWORK_ERROR" | "MALFORMED_RESPONSE" | "TOOL_CALL_ERROR"
  | "TOOL_CALL_UNSUPPORTED" | "UNKNOWN_PROVIDER_ERROR";

const messages: Record<AIErrorCategory, (provider: string) => string> = {
  INVALID_API_KEY: (p) => `A chave central da ${p} é inválida ou não tem permissão para usar a API.`,
  INVALID_MODEL: (p) => `O modelo selecionado não existe ou não está disponível na ${p}.`,
  MODEL_UNAVAILABLE: (p) => `Este modelo da ${p} está temporariamente indisponível.`,
  INVALID_REQUEST: () => "A solicitação não foi aceita. Tente novamente em instantes.",
  RATE_LIMITED: (p) => `A ${p} limitou temporariamente as solicitações. Aguarde um pouco antes de tentar novamente.`,
  QUOTA_EXCEEDED: (p) => `A cota central da ${p} foi atingida.`,
  INSUFFICIENT_BALANCE: (p) => `O saldo central da ${p} é insuficiente para esta solicitação.`,
  BILLING_REQUIRED: (p) => `A ${p} informou uma exigência de faturamento para a conta central.`,
  PERMISSION_DENIED: (p) => `A chave central da ${p} não tem permissão para usar esta API ou este modelo.`,
  REGION_RESTRICTED: (p) => `Este modelo da ${p} não está disponível na região da conta central.`,
  CONTENT_BLOCKED: () => "A resposta foi bloqueada por uma política de segurança. Reformule a pergunta e tente novamente.",
  TIMEOUT: () => "A Val demorou demais para responder. Tente novamente em instantes.",
  PROVIDER_OVERLOADED: (p) => `A ${p} está temporariamente sobrecarregada. Tente novamente em instantes.`,
  PROVIDER_UNAVAILABLE: (p) => `O serviço da ${p} está temporariamente indisponível.`,
  NETWORK_ERROR: () => "Não foi possível alcançar o serviço da Val. Tente novamente em instantes.",
  MALFORMED_RESPONSE: (p) => `A ${p} respondeu em um formato inesperado.`,
  TOOL_CALL_ERROR: () => "Não foi possível consultar os dados solicitados com segurança. Tente reformular a pergunta.",
  TOOL_CALL_UNSUPPORTED: (p) => `O modelo atual da ${p} não oferece as ferramentas necessárias para esta solicitação.`,
  UNKNOWN_PROVIDER_ERROR: (p) => `A solicitação à ${p} falhou. Consulte o diagnóstico no Super Admin.`,
};

const SAFE_QUOTA_HEADERS = [
  "x-ratelimit-limit-requests", "x-ratelimit-remaining-requests", "x-ratelimit-reset-requests",
  "x-ratelimit-limit-tokens", "x-ratelimit-remaining-tokens", "x-ratelimit-reset-tokens",
  "retry-after", "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset",
] as const;

export class AIProviderError extends Error {
  readonly provider: AIProvider;
  readonly model: string;
  readonly category: AIErrorCategory;
  readonly httpStatus: number | null;
  readonly providerCode: string | null;
  readonly providerMessage: string | null;
  readonly requestId: string | null;
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;
  readonly quotaHeaders: Record<string, string>;

  constructor(args: {
    provider: AIProvider;
    model: string;
    category: AIErrorCategory;
    httpStatus?: number | null;
    providerCode?: string | null;
    providerMessage?: string | null;
    requestId?: string | null;
    retryAfterMs?: number | null;
    quotaHeaders?: Record<string, string>;
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
    this.retryAfterMs = Number.isFinite(args.retryAfterMs) && Number(args.retryAfterMs) > 0
      ? Math.min(24 * 60 * 60 * 1000, Math.round(Number(args.retryAfterMs)))
      : null;
    this.quotaHeaders = args.quotaHeaders || {};
  }
}

function safeQuotaHeaders(headers: unknown) {
  const values = new Map<string, unknown>();
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    for (const name of SAFE_QUOTA_HEADERS) values.set(name, headers.get(name));
  } else if (headers && typeof headers === "object") {
    for (const [name, value] of Object.entries(headers)) values.set(name.toLowerCase(), value);
  }
  return Object.fromEntries(SAFE_QUOTA_HEADERS.flatMap((name) => {
    const value = values.get(name);
    if (name === "retry-after" && typeof value === "string" && value.length <= 80) {
      const retryAfterMs = parseRetryAfterMs(value);
      return retryAfterMs !== null ? [[name, String(Math.ceil(retryAfterMs / 100) / 10)]] : [];
    }
    return typeof value === "string" && value.length <= 80 && /^[0-9][A-Za-z0-9 .:+-]*$/.test(value)
      ? [[name, value]]
      : [];
  }));
}

function parseRetryAfterMs(value: string | undefined, now = Date.now()) {
  if (!value) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric >= 0) {
    return numeric > 1_000_000_000 ? Math.max(0, numeric * 1000 - now) : numeric * 1000;
  }
  const duration = value.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)$/i);
  if (duration) {
    const multiplier = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[duration[2].toLowerCase() as "ms" | "s" | "m" | "h"];
    return Number(duration[1]) * multiplier;
  }
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

function retryAfterFromProviderMessage(message: string) {
  const match = message.match(/(?:try again|retry(?: after)?|reset)(?:\s+in)?\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|sec|seconds?|m|min|minutes?|h|hours?)/i);
  if (!match) return null;
  const unit = match[2].toLowerCase();
  const multiplier = unit.startsWith("ms") || unit.startsWith("millisecond") ? 1
    : unit === "m" || unit.startsWith("min") ? 60_000
      : unit === "h" || unit.startsWith("hour") ? 3_600_000 : 1000;
  return Number(match[1]) * multiplier;
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
      text: String(error.message || error.status || "").slice(0, 1000),
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
  const status = transportStatus !== null && (transportStatus < 200 || transportStatus >= 300)
    ? transportStatus
    : details.providerHttpStatus ?? transportStatus;
  const rawCode = typeof value.code === "string" ? value.code : "";
  const code = details.reason || details.status || details.code || rawCode;
  const codeText = `${rawCode} ${details.code} ${details.status} ${details.reason} ${details.quota}`.toLowerCase();
  const message = `${String(value.message || "")} ${details.text} ${codeText}`.toLowerCase();
  const rawHeaders = value.responseHeaders;
  const headers = safeQuotaHeaders(rawHeaders);
  const headerEntries = rawHeaders instanceof Headers
    ? [...rawHeaders.entries()].map(([name, headerValue]) => [name.toLowerCase(), headerValue] as const)
    : Object.entries(rawHeaders && typeof rawHeaders === "object" ? rawHeaders : {}).map(([name, headerValue]) => [name.toLowerCase(), String(headerValue)] as const);
  const requestId = headerEntries.find(([name]) => ["x-request-id", "request-id"].includes(name))?.[1];
  const resetHeader = headers["retry-after"] || headers["x-ratelimit-reset-tokens"] || headers["x-ratelimit-reset-requests"] || headers["x-ratelimit-reset"];
  const retryAfterMs = parseRetryAfterMs(resetHeader) ?? retryAfterFromProviderMessage(details.text);
  if (retryAfterMs && !headers["retry-after"] && !headers["x-ratelimit-reset-tokens"] && !headers["x-ratelimit-reset-requests"] && !headers["x-ratelimit-reset"]) {
    headers["retry-after"] = String(Math.ceil(retryAfterMs / 100) / 10);
  }
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

  return new AIProviderError({ provider, model, category, httpStatus: status, providerCode: code, providerMessage: details.text || undefined, requestId, retryAfterMs, quotaHeaders: headers });
}

export function logAIError(error: AIProviderError, latencyMs: number) {
  // Log diagnostics only: never provider response bodies, prompts, keys, or financial data.
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

export function createProviderModel(provider: string, apiKey: string, model: string): LanguageModel {
  if (provider !== "deepseek") throw new Error("Somente o provider central DeepSeek está habilitado.");
  return createOpenAICompatible({ name: "deepseek", apiKey, baseURL: "https://api.deepseek.com" })(model);
}
