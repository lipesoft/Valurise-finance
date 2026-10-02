import "server-only";

import { decryptPersonalAiKey } from "@/lib/personal-ai-crypto";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { indexValModelQuotaUsage, isProviderQuotaCoolingDown, isValProviderAllowed, providerCircuitDecision, providerQuotaUtilizationPercent, selectValModels, type ValModelCandidate, type ValModelRequirements, type ValProvider } from "./policy";
import { getValUsagePeriodStarts } from "./periods";

export type RoutedModel = ValModelCandidate & { apiKey: string; displayName: string; requiresProbe?: boolean; requiresProviderProbe?: boolean };
export type ValRouterRuntime = {
  enabled: boolean;
  settings: Record<string, unknown> | null;
  candidates: RoutedModel[];
  error?: string;
};

export async function loadValRouterRuntime(requirements: ValModelRequirements): Promise<ValRouterRuntime> {
  const admin = getSupabaseAdminClient();
  const [settingsResult, providersResult, modelsResult, keysResult] = await Promise.all([
    admin.from("val_ai_runtime_settings").select("*").eq("id", 1).maybeSingle(),
    admin.from("val_ai_providers").select("id, enabled, health_status, failure_count, circuit_open_until, priority, quota_headers, last_health_check, updated_at").eq("id", "deepseek"),
    admin.from("val_ai_models").select("*").eq("is_enabled", true).eq("provider_id", "deepseek"),
    admin.from("val_ai_provider_keys").select("provider_id, encrypted_api_key").eq("is_active", true).eq("provider_id", "deepseek"),
  ]);
  if (settingsResult.error || providersResult.error || modelsResult.error || keysResult.error || !settingsResult.data) {
    return { enabled: false, settings: null, candidates: [], error: "CONFIGURATION_UNAVAILABLE" };
  }
  const settings = settingsResult.data as Record<string, unknown>;
  const globallyEnabled = settings.val_enabled === true && settings.val_router_enabled === true;
  const providers = new Map((providersResult.data || []).map((provider: Record<string, unknown>) => [String(provider.id), provider]));
  const activeKeys = new Map<string, string>();
  for (const item of keysResult.data || []) {
    try { activeKeys.set(String(item.provider_id), decryptPersonalAiKey(String(item.encrypted_api_key))); }
    catch { /* A missing/invalid server encryption key fails closed for this provider. */ }
  }
  const { day: dailyStart, month: monthlyStart } = getValUsagePeriodStarts();
  const now = new Date();
  const usageResult = await admin.from("val_ai_usage_rollups").select("period_kind, period_start, provider_id, model_id, requests, attempts, input_tokens, output_tokens")
    .in("period_kind", ["day", "month"]).in("period_start", [dailyStart, monthlyStart]);
  if (usageResult.error) return { enabled: false, settings: null, candidates: [], error: "QUOTA_USAGE_UNAVAILABLE" };
  const usedByModel = indexValModelQuotaUsage((usageResult.data || []) as Array<{
    period_kind: string; provider_id: string | null; model_id: string | null; requests: number | null;
    attempts: number | null; input_tokens: number | null; output_tokens: number | null;
  }>);
  const rows: RoutedModel[] = [];
  for (const row of modelsResult.data || []) {
    const providerId = String(row.provider_id) as ValProvider;
    if (!isValProviderAllowed(providerId)) continue;
    const provider = providers.get(providerId);
    const apiKey = activeKeys.get(providerId);
    const providerGlobalFlag = settings.val_deepseek_enabled === true;
    if (!provider || !apiKey || !provider.enabled || !providerGlobalFlag) continue;
    if (settings.monthly_cost_hard_limit_usd !== null && settings.monthly_cost_hard_limit_usd !== undefined
      && (row.input_cost_per_million === null || row.input_cost_per_million === undefined
        || row.output_cost_per_million === null || row.output_cost_per_million === undefined)) continue;
    const providerCircuit = providerCircuitDecision(
      String(provider.health_status) as ValModelCandidate["health"],
      provider.circuit_open_until ? String(provider.circuit_open_until) : null,
    );
    if (providerCircuit === "blocked") continue;
    let modelHealth = String(row.health_status) as ValModelCandidate["health"];
    let circuitOpenUntil = row.circuit_open_until ? String(row.circuit_open_until) : null;
    let requiresProbe = false;
    if (modelHealth === "CIRCUIT_OPEN") {
      if (!circuitOpenUntil || Date.parse(circuitOpenUntil) > Date.now()) continue;
      // Candidate is visible for readiness, but only the chat route may atomically claim the probe before use.
      modelHealth = "DEGRADED";
      requiresProbe = true;
      circuitOpenUntil = null;
    } else if (modelHealth === "HALF_OPEN") continue;
    const dailyUsage = usedByModel.get(`day:${providerId}/${row.model_id}`) || { requests: 0, tokens: 0 };
    const monthlyUsage = usedByModel.get(`month:${providerId}/${row.model_id}`) || { requests: 0, tokens: 0 };
    const quotaLimit = (value: unknown) => value === null || value === undefined ? null : Number(value);
    const requestLimits = [
      { limit: quotaLimit(row.daily_request_limit), used: dailyUsage.requests },
      { limit: quotaLimit(row.monthly_request_limit), used: monthlyUsage.requests },
    ].filter((entry): entry is { limit: number; used: number } => entry.limit !== null && Number.isFinite(entry.limit) && entry.limit >= 0);
    const tokenLimits = [
      { limit: quotaLimit(row.daily_token_limit), used: dailyUsage.tokens },
      { limit: quotaLimit(row.monthly_token_limit), used: monthlyUsage.tokens },
    ].filter((entry): entry is { limit: number; used: number } => entry.limit !== null && Number.isFinite(entry.limit) && entry.limit >= 0);
    if ([...requestLimits, ...tokenLimits].some((entry) => entry.limit === 0)) continue;
    const quota = provider.quota_headers && typeof provider.quota_headers === "object" ? provider.quota_headers as Record<string, string> : {};
    const providerUsagePercent = providerQuotaUtilizationPercent(quota);
    let providerQuotaRemaining = providerUsagePercent === null ? null : Math.max(0, 1 - providerUsagePercent / 100);
    const hardQuotaPercent = Number(settings.hard_quota_percent || 98);
    const quotaObservedAt = provider.last_health_check || provider.updated_at;
    const isHardQuota = providerUsagePercent !== null && providerUsagePercent >= hardQuotaPercent;
    if (isProviderQuotaCoolingDown(quota, quotaObservedAt ? String(quotaObservedAt) : null, now.getTime(), isHardQuota)) continue;
    if (providerUsagePercent !== null && providerUsagePercent >= hardQuotaPercent) {
      providerQuotaRemaining = null;
    }
    const quotaRemainingRatio = Math.min(
      ...requestLimits.map(({ limit, used }) => Math.max(0, (limit - used) / limit)),
      ...tokenLimits.map(({ limit, used }) => Math.max(0, (limit - used) / limit)),
      providerQuotaRemaining ?? 1,
      1,
    );
    const hardLimitRemaining = 1 - hardQuotaPercent / 100;
    if (quotaRemainingRatio <= hardLimitRemaining) continue;
    rows.push({
      provider: providerId,
      modelId: String(row.model_id),
      displayName: String(row.display_name),
      isFree: row.is_free === true,
      freeVerified: row.free_verified === true,
      enabled: row.is_enabled === true,
      supportsChat: row.supports_chat === true,
      supportsTools: row.supports_tools === true,
      supportsStructuredOutput: row.supports_structured_output === true,
      supportsReasoning: row.supports_reasoning === true,
      contextWindow: Number.isSafeInteger(Number(row.context_window)) ? Number(row.context_window) : null,
      health: modelHealth,
      circuitOpenUntil,
      priority: Number(row.priority || provider.priority || 100) + (providerUsagePercent !== null && providerUsagePercent >= Number(settings.deprioritize_quota_percent || 90) ? 100 : 0),
      latencyMs: row.last_latency_ms === null ? null : Number(row.last_latency_ms),
      successRate: null,
      quotaRemainingRatio: quotaRemainingRatio === 1 && !requestLimits.length && !tokenLimits.length ? null : quotaRemainingRatio,
      providerEnabled: provider.enabled === true,
      inputCostPerMillion: row.input_cost_per_million === null ? null : Number(row.input_cost_per_million),
      outputCostPerMillion: row.output_cost_per_million === null ? null : Number(row.output_cost_per_million),
      apiKey,
      requiresProbe,
      requiresProviderProbe: providerCircuit === "probe",
    });
  }
  const ordered = selectValModels(rows, requirements).map((candidate) => rows.find((row) => row.provider === candidate.provider && row.modelId === candidate.modelId)!).filter(Boolean);
  return { enabled: globallyEnabled, settings, candidates: ordered };
}

export async function loadValProviderKey(provider: ValProvider) {
  if (!isValProviderAllowed(provider)) return null;
  const admin = getSupabaseAdminClient();
  const { data, error } = await admin.from("val_ai_provider_keys").select("encrypted_api_key").eq("provider_id", provider).eq("is_active", true).maybeSingle();
  if (error || !data) return null;
  try { return decryptPersonalAiKey(data.encrypted_api_key); }
  catch { return null; }
}

export function valFeatureIsEnabled(settings: Record<string, unknown> | null, feature: "actions" | "insights") {
  return settings?.val_enabled === true && settings?.val_router_enabled === true
    && settings[feature === "actions" ? "val_actions_enabled" : "val_insights_enabled"] === true;
}
