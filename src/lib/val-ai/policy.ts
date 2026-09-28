export type ValProvider = "groq" | "openrouter";
export type ValHealth = "HEALTHY" | "DEGRADED" | "UNAVAILABLE" | "CIRCUIT_OPEN" | "HALF_OPEN" | "DISABLED" | "QUOTA_EXHAUSTED";
export type ValModelCandidate = {
  provider: ValProvider;
  modelId: string;
  isFree: boolean;
  freeVerified: boolean;
  enabled: boolean;
  supportsChat: boolean;
  supportsTools: boolean;
  supportsStructuredOutput: boolean;
  supportsReasoning: boolean;
  contextWindow: number | null;
  health: ValHealth;
  circuitOpenUntil: string | null;
  priority: number;
  latencyMs: number | null;
  successRate: number | null;
  quotaRemainingRatio: number | null;
  providerEnabled: boolean;
  freeTierConfirmed: boolean;
};

export type ValModelRequirements = {
  tools?: boolean;
  structuredOutput?: boolean;
  reasoning?: boolean;
  contextTokens?: number;
  now?: number;
};

export function indexValModelQuotaUsage(rows: Array<{
  period_kind: string;
  provider_id: string | null;
  model_id: string | null;
  requests: number | null;
  attempts?: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
}>) {
  const usage = new Map<string, { requests: number; tokens: number }>();
  for (const row of rows) {
    if (!row.provider_id || !row.model_id) continue;
    const key = `${row.period_kind}:${row.provider_id}/${row.model_id}`;
    const current = usage.get(key) || { requests: 0, tokens: 0 };
    // Model/provider limits count each billable provider call, including fallbacks.
    current.requests += Math.max(0, Number(row.attempts ?? row.requests ?? 0));
    current.tokens += Math.max(0, Number(row.input_tokens || 0)) + Math.max(0, Number(row.output_tokens || 0));
    usage.set(key, current);
  }
  return usage;
}

/** This is the last application-level guard before every model call. */
export function isApprovedFreeModel(candidate: ValModelCandidate, requirements: ValModelRequirements = {}) {
  const now = requirements.now ?? Date.now();
  if (!candidate.isFree || !candidate.freeVerified || !candidate.enabled || !candidate.supportsChat) return false;
  if (!candidate.providerEnabled || candidate.provider === "groq" && !candidate.freeTierConfirmed) return false;
  if (candidate.health !== "HEALTHY" && candidate.health !== "DEGRADED") return false;
  if (candidate.circuitOpenUntil && Date.parse(candidate.circuitOpenUntil) > now) return false;
  if (candidate.quotaRemainingRatio !== null && candidate.quotaRemainingRatio <= 0) return false;
  if (requirements.tools && !candidate.supportsTools) return false;
  if (requirements.structuredOutput && !candidate.supportsStructuredOutput) return false;
  if (requirements.reasoning && !candidate.supportsReasoning) return false;
  if (requirements.contextTokens && (candidate.contextWindow === null || candidate.contextWindow < requirements.contextTokens)) return false;
  return true;
}

export function selectFreeModels<TCandidate extends ValModelCandidate>(candidates: TCandidate[], requirements: ValModelRequirements = {}) {
  return candidates.filter((candidate) => isApprovedFreeModel(candidate, requirements)).sort((a, b) => {
    const healthRank = (value: ValHealth) => value === "HEALTHY" ? 2 : value === "DEGRADED" ? 1 : 0;
    const healthDifference = healthRank(b.health) - healthRank(a.health);
    if (healthDifference) return healthDifference;
    const quotaDifference = (b.quotaRemainingRatio ?? 1) - (a.quotaRemainingRatio ?? 1);
    if (quotaDifference) return quotaDifference;
    const successDifference = (b.successRate ?? 0.5) - (a.successRate ?? 0.5);
    if (successDifference) return successDifference;
    const priorityDifference = a.priority - b.priority;
    if (priorityDifference) return priorityDifference;
    const latencyDifference = (a.latencyMs ?? Number.MAX_SAFE_INTEGER) - (b.latencyMs ?? Number.MAX_SAFE_INTEGER);
    return latencyDifference || `${a.provider}/${a.modelId}`.localeCompare(`${b.provider}/${b.modelId}`);
  });
}

export function isFallbackEligible(category: string) {
  return new Set([
    "RATE_LIMITED", "QUOTA_EXCEEDED", "PROVIDER_OVERLOADED", "MODEL_UNAVAILABLE",
    "PROVIDER_UNAVAILABLE", "TIMEOUT", "NETWORK_ERROR", "UNKNOWN_PROVIDER_ERROR",
    "INVALID_API_KEY", "PERMISSION_DENIED", "BILLING_REQUIRED", "INSUFFICIENT_BALANCE",
  ]).has(category);
}

export async function runFreeModelCandidates<TCandidate extends ValModelCandidate, T>(
  candidates: TCandidate[],
  requirements: ValModelRequirements,
  maxAttempts: number,
  call: (candidate: TCandidate, attempt: number) => Promise<T>,
) {
  const eligible = selectFreeModels(candidates, requirements).slice(0, Math.max(1, Math.min(3, Math.trunc(maxAttempts))));
  const attempts: Array<{ candidate: ValModelCandidate; error: unknown }> = [];
  const unavailableProviders = new Set<string>();
  for (const candidate of eligible) {
    if (unavailableProviders.has(candidate.provider)) continue;
    // Recheck immediately at the adapter boundary; never trust a stale router decision.
    if (!isApprovedFreeModel(candidate, requirements)) continue;
    try {
      return { candidate, attempt: attempts.length + 1, attempts, result: await call(candidate, attempts.length + 1) };
    } catch (error) {
      attempts.push({ candidate, error });
      if (error && typeof error === "object" && "noFallback" in error && error.noFallback === true) throw error;
      const category = error && typeof error === "object" && "category" in error ? String(error.category) : "UNKNOWN_PROVIDER_ERROR";
      if (!isFallbackEligible(category)) throw Object.assign(error instanceof Error ? error : new Error("Val provider request failed"), { valAttempts: attempts });
      if (category !== "MODEL_UNAVAILABLE" && category !== "INVALID_MODEL") unavailableProviders.add(candidate.provider);
    }
  }
  throw Object.assign(new Error("ALL_FREE_MODELS_UNAVAILABLE"), { code: "ALL_FREE_MODELS_UNAVAILABLE", valAttempts: attempts });
}

export function isFreeModelCatalogFresh(lastCheckedAt: string | null | undefined, now = Date.now(), maxAgeMs = 24 * 60 * 60 * 1000) {
  if (!lastCheckedAt) return false;
  const checkedAt = Date.parse(lastCheckedAt);
  return Number.isFinite(checkedAt) && checkedAt <= now && now - checkedAt <= maxAgeMs;
}

/** Highest utilization explicitly reported by provider rate-limit headers. */
export function providerQuotaUtilizationPercent(headers: Record<string, string>) {
  const pairs = [
    ["x-ratelimit-limit-tokens", "x-ratelimit-remaining-tokens"],
    ["x-ratelimit-limit-requests", "x-ratelimit-remaining-requests"],
    ["x-ratelimit-limit", "x-ratelimit-remaining"],
  ] as const;
  const values = pairs.flatMap(([limitKey, remainingKey]) => {
    const limit = Number(headers[limitKey]);
    const remaining = Number(headers[remainingKey]);
    return Number.isFinite(limit) && limit > 0 && Number.isFinite(remaining) && remaining >= 0
      ? [Math.max(0, Math.min(100, (1 - remaining / limit) * 100))]
      : [];
  });
  return values.length ? Math.max(...values) : null;
}

export function classifyValTask(text: string, needsFinancialData: boolean, requestsAction: boolean) {
  if (requestsAction) return "ACTION_PROPOSAL" as const;
  if (needsFinancialData) return "TOOL_CALL" as const;
  if (/resuma|analise|compare|tend[eê]ncia|panorama|vis[aã]o geral/i.test(text)) return "FINANCIAL_ANALYSIS" as const;
  if (/json|em formato|estruturad/i.test(text)) return "STRUCTURED_RESPONSE" as const;
  if (text.length > 1500) return "LONG_CONTEXT" as const;
  return "GENERAL_CHAT" as const;
}
