import "server-only";

import { createProviderModel } from "@/lib/personal-ai/providers";
import { isApprovedFreeModel } from "./policy";
import type { RoutedModel } from "./router";

/** Every execution path, including tests and fallbacks, must cross this gate. */
export function createValModel(candidate: RoutedModel, requireTools = false) {
  if (!isApprovedFreeModel(candidate, { tools: requireTools })) {
    throw Object.assign(new Error("FREE_MODEL_POLICY_BLOCKED"), { code: "FREE_MODEL_POLICY_BLOCKED" });
  }
  return createProviderModel(candidate.provider, candidate.apiKey, candidate.modelId);
}
