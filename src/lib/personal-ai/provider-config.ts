/** The Val runtime deliberately supports one centrally managed provider. */
export const AI_PROVIDERS = ["deepseek"] as const;
export type AIProvider = (typeof AI_PROVIDERS)[number];

export const AI_PROVIDER_METADATA: Record<AIProvider, { label: string }> = {
  deepseek: { label: "DeepSeek" },
};

export function isAIProvider(value: unknown): value is AIProvider {
  return value === "deepseek";
}
