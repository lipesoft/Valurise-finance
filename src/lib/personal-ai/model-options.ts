import type { AIModelOption, AIProvider } from "./provider-config";

export const GEMINI_SUPPORTED_MODELS = [
  { id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash-Lite", tier: "recommended" },
  { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", tier: "economical" },
] as const;

export const OPENROUTER_FREE_MODEL: AIModelOption = {
  id: "openrouter/free",
  label: "OpenRouter Free · Recomendado",
  tier: "recommended",
  free: true,
  provider: "openrouter",
};

export function getInitialAIModelOptions(provider: AIProvider): AIModelOption[] {
  if (provider === "gemini") return GEMINI_SUPPORTED_MODELS.map((option) => ({ ...option, provider }));
  if (provider === "openrouter") return [{ ...OPENROUTER_FREE_MODEL }];
  return [];
}

export function isSupportedGeminiModel(model: string) {
  return GEMINI_SUPPORTED_MODELS.some((option) => option.id === model);
}

export function isGemini25FlashModel(model: string) {
  return /^gemini-2\.5-flash(?:-lite)?$/i.test(model);
}
