export const GEMINI_SUPPORTED_MODELS = [
  { id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash-Lite", tier: "recommended" },
  { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", tier: "economical" },
] as const;

export function isSupportedGeminiModel(model: string) {
  return GEMINI_SUPPORTED_MODELS.some((option) => option.id === model);
}

export function isGemini25FlashModel(model: string) {
  return /^gemini-2\.5-flash(?:-lite)?$/i.test(model);
}
