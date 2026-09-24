import "server-only";

import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import type { AIProvider, AIProviderError } from "@/lib/personal-ai/providers";

export async function recordPersonalAIUsage(args: {
  userId: string; provider: AIProvider; model: string; inputTokens?: number; outputTokens?: number;
  latencyMs: number; kind: "chat" | "connection_test"; error?: AIProviderError;
}) {
  try {
    const admin = getSupabaseAdminClient();
    const { error } = await admin.from("personal_ai_usage_events").insert({
      user_id: args.userId,
      provider: args.provider,
      model: args.model,
      input_tokens: args.inputTokens ?? null,
      output_tokens: args.outputTokens ?? null,
      latency_ms: Math.max(0, Math.min(120_000, Math.round(args.latencyMs))),
      kind: args.kind,
      error_category: args.error?.category ?? null,
      provider_code: args.error?.providerCode ?? null,
      request_id: args.error?.requestId ?? null,
    });
    if (error) console.error("Val AI usage telemetry unavailable", JSON.stringify({ provider: args.provider, kind: args.kind, code: error.code }));
  } catch {
    // Usage logging is best-effort and must never block an answer or a connection test.
  }
}
