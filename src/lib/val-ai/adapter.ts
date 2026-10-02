import "server-only";

import { createProviderModel } from "@/lib/personal-ai/providers";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { isApprovedValModel, isValProviderAllowed } from "./policy";
import { loadValProviderKey } from "./router";
import type { RoutedModel } from "./router";

/** Every execution path, including tests and fallbacks, must cross this gate. */
export async function createValModel(candidate: RoutedModel, requireTools = false) {
  if (!isValProviderAllowed(candidate.provider)) {
    throw Object.assign(new Error("VAL_PROVIDER_DISABLED"), { code: "VAL_PROVIDER_DISABLED" });
  }
  if (!isApprovedValModel(candidate, { tools: requireTools })) {
    throw Object.assign(new Error("VAL_MODEL_POLICY_BLOCKED"), { code: "VAL_MODEL_POLICY_BLOCKED" });
  }
  const admin = getSupabaseAdminClient();
  const [{ data: provider }, { data: model }, { data: settings }, currentKey] = await Promise.all([
    admin.from("val_ai_providers").select("enabled, health_status, circuit_open_until").eq("id", candidate.provider).maybeSingle(),
    admin.from("val_ai_models").select("is_enabled, supports_chat, supports_tools, supports_structured_output, supports_reasoning, health_status, circuit_open_until, context_window, input_cost_per_million, output_cost_per_million").eq("provider_id", candidate.provider).eq("model_id", candidate.modelId).maybeSingle(),
    admin.from("val_ai_runtime_settings").select("val_enabled, val_router_enabled, val_deepseek_enabled, val_fallback_enabled, monthly_cost_hard_limit_usd").eq("id", 1).maybeSingle(),
    loadValProviderKey(candidate.provider),
  ]);
  const globalProviderEnabled = settings?.val_deepseek_enabled === true;
  if (!provider?.enabled || !model?.is_enabled || !model.supports_chat || !settings?.val_enabled || !settings.val_router_enabled
    || !globalProviderEnabled
    || !currentKey || currentKey !== candidate.apiKey
    || (settings.monthly_cost_hard_limit_usd !== null && settings.monthly_cost_hard_limit_usd !== undefined
      && (model.input_cost_per_million === null || model.input_cost_per_million === undefined
        || model.output_cost_per_million === null || model.output_cost_per_million === undefined))) {
    throw Object.assign(new Error("VAL_MODEL_POLICY_BLOCKED"), { code: "VAL_MODEL_POLICY_BLOCKED" });
  }
  if (requireTools && !model.supports_tools) throw Object.assign(new Error("VAL_MODEL_CAPABILITY_BLOCKED"), { code: "VAL_MODEL_CAPABILITY_BLOCKED" });
  const freshCandidate = {
    ...candidate,
    enabled: model.is_enabled === true,
    providerEnabled: provider.enabled === true,
    health: model.health_status as typeof candidate.health,
    circuitOpenUntil: model.circuit_open_until ? String(model.circuit_open_until) : provider.circuit_open_until ? String(provider.circuit_open_until) : null,
    supportsChat: model.supports_chat === true,
    supportsTools: model.supports_tools === true,
    supportsStructuredOutput: model.supports_structured_output === true,
    supportsReasoning: model.supports_reasoning === true,
    contextWindow: model.context_window === null ? null : Number(model.context_window),
  };
  if (!isApprovedValModel(freshCandidate, { tools: requireTools })) {
    throw Object.assign(new Error("VAL_MODEL_POLICY_BLOCKED"), { code: "VAL_MODEL_POLICY_BLOCKED" });
  }
  return createProviderModel(candidate.provider, candidate.apiKey, candidate.modelId);
}
