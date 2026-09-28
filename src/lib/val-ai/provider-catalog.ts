import "server-only";

import { AIProviderError, classifyAIError } from "@/lib/personal-ai/providers";
import { parseProviderModelCatalog, readSafeQuotaHeaders, type CatalogEntry } from "./catalog-policy";
import type { ValProvider } from "./policy";

export { readSafeQuotaHeaders } from "./catalog-policy";
export type { CatalogEntry } from "./catalog-policy";

const baseUrls: Record<ValProvider, string> = {
  groq: "https://api.groq.com/openai/v1",
  openrouter: "https://openrouter.ai/api/v1",
};

export function providerDisplayName(provider: ValProvider) {
  return provider === "groq" ? "Groq" : "OpenRouter";
}

function openRouterReferer() {
  const configured = process.env.NEXT_PUBLIC_SITE_URL;
  if (!configured) return undefined;
  try {
    const url = new URL(configured);
    if (url.protocol !== "https:" || url.username || url.password) return undefined;
    return url.origin;
  } catch { return undefined; }
}

export async function discoverFreeModelCatalog(provider: ValProvider, apiKey: string, signal?: AbortSignal): Promise<{ models: CatalogEntry[]; quotaHeaders: Record<string, string> }> {
  const url = provider === "openrouter" ? `${baseUrls[provider]}/models?output_modalities=text` : `${baseUrls[provider]}/models`;
  const referer = provider === "openrouter" ? openRouterReferer() : undefined;
  let response: Response;
  try {
    response = await fetch(url, { method: "GET", cache: "no-store", signal, headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(provider === "openrouter" ? { "X-OpenRouter-Title": "Valurise", ...(referer ? { "HTTP-Referer": referer } : {}) } : {}),
    } });
  } catch (error) {
    throw classifyAIError(error, provider, "catalog");
  }
  const quotaHeaders = readSafeQuotaHeaders(response.headers);
  const bodyText = await response.text().catch(() => "");
  if (!response.ok) {
    const wrapped = Object.assign(new Error("Provider catalog request failed"), {
      statusCode: response.status,
      responseBody: bodyText.slice(0, 1600),
      responseHeaders: quotaHeaders,
    });
    throw classifyAIError(wrapped, provider, "catalog");
  }
  let payload: unknown;
  try { payload = JSON.parse(bodyText) as Record<string, unknown>; }
  catch { throw new AIProviderError({ provider, model: "catalog", category: "MALFORMED_RESPONSE", httpStatus: response.status }); }
  return { models: parseProviderModelCatalog(provider, payload), quotaHeaders };
}

export function providerApiBaseUrl(provider: ValProvider) {
  return baseUrls[provider];
}
