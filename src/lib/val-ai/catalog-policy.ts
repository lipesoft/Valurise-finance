export type CatalogEntry = {
  provider_id: "deepseek";
  model_id: string;
  display_name: string;
  is_free: boolean;
  official_prompt_price: number | null;
  official_completion_price: number | null;
  context_window: number | null;
  supports_chat: boolean;
};

export function readSafeQuotaHeaders(headers: Headers) {
  const allow = [
    "x-ratelimit-limit-requests", "x-ratelimit-remaining-requests", "x-ratelimit-reset-requests",
    "x-ratelimit-limit-tokens", "x-ratelimit-remaining-tokens", "x-ratelimit-reset-tokens",
    "retry-after", "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset",
  ];
  return Object.fromEntries(allow.flatMap((name) => {
    const value = headers.get(name);
    // Persist only quota-shaped metadata, never provider-controlled free text.
    return value && value.length <= 80 && /^[0-9][A-Za-z0-9 .:+-]*$/.test(value) ? [[name, value]] : [];
  }));
}

function numericPrice(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function chatSuitable(row: Record<string, unknown>, id: string) {
  if (/(speech|whisper|tts|transcri|audio|moderation|prompt.?guard|safeguard|embedding|embed)/i.test(id)) return false;
  const architecture = row.architecture;
  if (architecture && typeof architecture === "object") {
    const modalities = (architecture as Record<string, unknown>).output_modalities;
    if (Array.isArray(modalities) && !modalities.includes("text")) return false;
  }
  return true;
}

/** Parses only DeepSeek's public catalog; DeepSeek models are never marked free by inference. */
export function parseDeepseekModelCatalog(payload: unknown): CatalogEntry[] {
  if (!payload || typeof payload !== "object") return [];
  const rows = (payload as Record<string, unknown>).data;
  if (!Array.isArray(rows)) return [];
  const models = rows.flatMap((item): CatalogEntry[] => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    const id = String(row.id || "").trim();
    if (!/^(?=.{2,150}$)(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9._:/-]+$/.test(id) || !chatSuitable(row, id)) return [];
    const pricing = row.pricing && typeof row.pricing === "object" ? row.pricing as Record<string, unknown> : {};
    const prompt = numericPrice(pricing.prompt);
    const completion = numericPrice(pricing.completion);
    const context = Number(row.context_window ?? row.context_length ?? 0);
    return [{
      provider_id: "deepseek",
      model_id: id,
      display_name: String(row.name || row.display_name || id).slice(0, 160),
      is_free: false,
      official_prompt_price: prompt,
      official_completion_price: completion,
      context_window: Number.isSafeInteger(context) && context > 0 ? Math.min(context, 2_000_000) : null,
      supports_chat: true,
    }];
  });
  return [...new Map(models.map((model) => [model.model_id, model])).values()]
    .sort((a, b) => a.model_id.localeCompare(b.model_id))
    .slice(0, 500);
}
