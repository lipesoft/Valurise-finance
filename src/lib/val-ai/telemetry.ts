import "server-only";

import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import type { AIErrorCategory, AIProviderError } from "@/lib/personal-ai/providers";
import type { ValProvider } from "./policy";

function safeCode(value: string | null | undefined) {
  if (!value) return null;
  const safe = value.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 100);
  return safe || null;
}

export async function recordValAiAttempt(args: {
  requestId: string;
  userId: string;
  workspaceId: string;
  taskType: string;
  attempt: number;
  provider: ValProvider | null;
  model: string | null;
  status: "SUCCESS" | "FAILED" | "BLOCKED";
  latencyMs: number;
  inputTokens?: number | null;
  outputTokens?: number | null;
  estimatedCostUsd?: number | null;
  errorCategory?: AIErrorCategory | string | null;
  providerCode?: string | null;
  httpStatus?: number | null;
  providerRequestId?: string | null;
  quotaHeaders?: Record<string, string>;
}) {
  const admin = getSupabaseAdminClient();
  const { error } = await admin.from("val_ai_usage_events").insert({
    request_id: args.requestId,
    user_id: args.userId,
    workspace_id: args.workspaceId,
    provider_id: args.provider,
    model_id: args.model,
    task_type: args.taskType,
    attempt_index: Math.max(1, Math.min(3, Math.trunc(args.attempt))),
    status: args.status,
    input_tokens: Number.isSafeInteger(args.inputTokens) && Number(args.inputTokens) >= 0 ? args.inputTokens : null,
    output_tokens: Number.isSafeInteger(args.outputTokens) && Number(args.outputTokens) >= 0 ? args.outputTokens : null,
    estimated_cost_usd: typeof args.estimatedCostUsd === "number" && Number.isFinite(args.estimatedCostUsd) && args.estimatedCostUsd >= 0 ? args.estimatedCostUsd : null,
    latency_ms: Math.max(0, Math.min(120_000, Math.round(args.latencyMs))),
    error_category: safeCode(args.errorCategory),
    provider_code: safeCode(args.providerCode),
    http_status: args.httpStatus && args.httpStatus >= 100 && args.httpStatus <= 599 ? args.httpStatus : null,
    provider_request_id: safeCode(args.providerRequestId),
    quota_metadata: args.quotaHeaders || {},
  });
  if (error) console.error("Val centralized AI telemetry unavailable", JSON.stringify({ requestId: args.requestId, code: error.code || "UNKNOWN" }));
}

export async function recordValAiModelHealth(args: {
  provider: ValProvider;
  model: string;
  ok: boolean;
  latencyMs: number;
  category?: string | null;
  providerCode?: string | null;
  quotaHeaders?: Record<string, string>;
}) {
  const admin = getSupabaseAdminClient();
  const { error } = await admin.rpc("record_val_ai_model_result", {
    p_provider_id: args.provider,
    p_model_id: args.model,
    p_success: args.ok,
    p_latency_ms: Math.max(0, Math.min(120_000, Math.round(args.latencyMs))),
    p_error_category: safeCode(args.category),
    p_error_code: safeCode(args.providerCode),
    p_quota_headers: args.quotaHeaders || {},
  });
  if (error) console.error("Val AI health update unavailable", JSON.stringify({ provider: args.provider, model: args.model, code: error.code || "UNKNOWN" }));
}

export async function recordValAiBlockedRequest(args: {
  requestId: string; userId: string; workspaceId: string; taskType: string; reason: string;
}) {
  await recordValAiAttempt({
    requestId: args.requestId, userId: args.userId, workspaceId: args.workspaceId,
    taskType: args.taskType, attempt: 1, provider: null, model: null, status: "BLOCKED",
    latencyMs: 0, errorCategory: args.reason,
  });
}
