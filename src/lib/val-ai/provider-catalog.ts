import "server-only";

import { AIProviderError, classifyAIError } from "@/lib/personal-ai/providers";
import { parseDeepseekModelCatalog, readSafeQuotaHeaders, type CatalogEntry } from "./catalog-policy";
import { isValProviderAllowed, type ValProvider } from "./policy";

export { readSafeQuotaHeaders } from "./catalog-policy";
export type { CatalogEntry } from "./catalog-policy";

const baseUrls: Record<ValProvider, string> = { deepseek: "https://api.deepseek.com" };

export function providerDisplayName(provider: ValProvider) {
  if (!isValProviderAllowed(provider)) throw Object.assign(new Error("VAL_PROVIDER_DISABLED"), { code: "VAL_PROVIDER_DISABLED" });
  return "DeepSeek";
}

export async function discoverModelCatalog(provider: ValProvider, apiKey: string, signal?: AbortSignal): Promise<{ models: CatalogEntry[]; quotaHeaders: Record<string, string> }> {
  if (!isValProviderAllowed(provider)) throw Object.assign(new Error("VAL_PROVIDER_DISABLED"), { code: "VAL_PROVIDER_DISABLED" });
  const url = `${baseUrls[provider]}/models`;
  let response: Response;
  try {
    response = await fetch(url, { method: "GET", cache: "no-store", signal, headers: {
      Authorization: `Bearer ${apiKey}`,
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
  return { models: parseDeepseekModelCatalog(payload), quotaHeaders };
}

export function providerApiBaseUrl(provider: ValProvider) {
  return baseUrls[provider];
}
