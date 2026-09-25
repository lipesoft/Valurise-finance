export const AI_PROVIDERS = ["openai", "gemini", "deepseek", "groq", "openrouter"] as const;
export type AIProvider = (typeof AI_PROVIDERS)[number];
export type AIModelTier = "recommended" | "economical" | "advanced" | "other";
export type AIModelOption = {
  id: string;
  label: string;
  tier: AIModelTier;
  free?: boolean;
  provider?: AIProvider;
};

export const AI_PROVIDER_METADATA: Record<AIProvider, {
  label: string;
  defaultModel: string;
  supportsDynamicCatalog: boolean;
}> = {
  openai: { label: "OpenAI", defaultModel: "gpt-5-mini", supportsDynamicCatalog: true },
  gemini: { label: "Gemini", defaultModel: "gemini-2.5-flash-lite", supportsDynamicCatalog: false },
  deepseek: { label: "DeepSeek", defaultModel: "deepseek-v4-flash", supportsDynamicCatalog: true },
  groq: { label: "Groq", defaultModel: "openai/gpt-oss-20b", supportsDynamicCatalog: true },
  openrouter: { label: "OpenRouter", defaultModel: "openrouter/free", supportsDynamicCatalog: true },
};

export const AI_MODEL_ID_PATTERN = /^(?=.{2,100}$)(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9._:-]+(?:\/[A-Za-z0-9._:-]+)*$/;

export function isSafeAIModelId(value: string): boolean {
  return AI_MODEL_ID_PATTERN.test(value);
}

export function isAIProvider(value: unknown): value is AIProvider {
  return typeof value === "string" && AI_PROVIDERS.includes(value as AIProvider);
}
