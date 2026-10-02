import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { generateText, tool } from "ai";
import { z } from "zod";
import { createValModel } from "@/lib/val-ai/adapter";
import { getValHealthCheckPrompt, isValHealthCheckSuccessful, VAL_HEALTH_CHECK_TOOL_DESCRIPTION, VAL_HEALTH_CHECK_TOOL_NAME } from "@/lib/val-ai/health-check";
import { discoverModelCatalog, readSafeQuotaHeaders } from "@/lib/val-ai/provider-catalog";
import { estimateValRequestCostUsd, getValServiceStatus, isApprovedValModel, type ValModelCandidate, type ValProvider } from "@/lib/val-ai/policy";
import { loadValProviderKey, loadValRouterRuntime } from "@/lib/val-ai/router";
import { classifyAIError } from "@/lib/personal-ai/providers";
import { encryptPersonalAiKey } from "@/lib/personal-ai-crypto";
import { getSupabaseAdminClient, getVerifiedMaster } from "@/lib/supabase/admin";
import { getValUsagePeriodStarts } from "@/lib/val-ai/periods";
import { diagnoseValAIAdminDatabaseError } from "@/lib/val-ai/admin-database-error";

export const dynamic = "force-dynamic";
export const maxDuration = 20;

const providerSchema = z.literal("deepseek");
const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("save_key"), provider: providerSchema, apiKey: z.string().trim().min(16).max(512) }).strict(),
  z.object({ action: z.literal("remove_key"), provider: providerSchema }).strict(),
  z.object({ action: z.literal("set_provider"), provider: providerSchema, enabled: z.boolean() }).strict(),
  z.object({ action: z.literal("refresh_catalog"), provider: providerSchema }).strict(),
  z.object({ action: z.literal("update_model"), provider: providerSchema, modelId: z.string().trim().min(2).max(150).regex(/^[A-Za-z0-9._:/-]+$/), isFree: z.boolean(), enabled: z.boolean(), priority: z.number().int().min(1).max(1000), supportsTools: z.boolean(), supportsStructuredOutput: z.boolean(), supportsReasoning: z.boolean(), inputCostPerMillion: z.number().min(0).max(100000).nullable(), outputCostPerMillion: z.number().min(0).max(100000).nullable(), dailyRequestLimit: z.number().int().min(0).max(1000000).nullable(), monthlyRequestLimit: z.number().int().min(0).max(10000000).nullable(), dailyTokenLimit: z.number().int().min(0).max(1000000000).nullable(), monthlyTokenLimit: z.number().int().min(0).max(10000000000).nullable() }).strict(),
  z.object({ action: z.literal("test_model"), provider: providerSchema, modelId: z.string().trim().min(2).max(150).regex(/^[A-Za-z0-9._:/-]+$/) }).strict(),
  z.object({ action: z.literal("save_limits"), dailyRequests: z.number().int().min(0).max(10000), monthlyRequests: z.number().int().min(0).max(100000), dailyTokens: z.number().int().min(0).max(100000000), monthlyTokens: z.number().int().min(0).max(1000000000), maxContextTokens: z.number().int().min(2000).max(1000000), maxOutputTokens: z.number().int().min(16).max(32000), maxAttempts: z.number().int().min(1).max(3), circuitFailureThreshold: z.number().int().min(1).max(20), circuitCooldownSeconds: z.number().int().min(10).max(86400), softQuotaPercent: z.number().int().min(1).max(99), deprioritizeQuotaPercent: z.number().int().min(2).max(99), hardQuotaPercent: z.number().int().min(50).max(100), monthlyCostSoftLimitUsd: z.number().min(0).max(1000000), monthlyCostHardLimitUsd: z.number().min(0).max(1000000), referenceBalanceUsd: z.number().min(0).max(1000000).nullable(), valEnabled: z.boolean(), routerEnabled: z.boolean(), deepseekEnabled: z.boolean(), fallbackEnabled: z.boolean(), actionsEnabled: z.boolean(), insightsEnabled: z.boolean() }).strict().refine((value) => value.softQuotaPercent < value.deprioritizeQuotaPercent && value.deprioritizeQuotaPercent < value.hardQuotaPercent, "Os limites precisam seguir: atenção < reduzir prioridade < bloqueio.").refine((value) => value.monthlyCostSoftLimitUsd <= value.monthlyCostHardLimitUsd, "O limite de atenção não pode superar o limite mensal máximo."),
  z.object({ action: z.literal("set_user_override"), userId: z.string().uuid(), blocked: z.boolean(), dailyRequests: z.number().int().min(0).max(10000).nullable(), monthlyRequests: z.number().int().min(0).max(100000).nullable(), dailyTokens: z.number().int().min(0).max(100000000).nullable(), monthlyTokens: z.number().int().min(0).max(1000000000).nullable(), maxContextTokens: z.number().int().min(2000).max(1000000).nullable(), maxOutputTokens: z.number().int().min(16).max(32000).nullable() }).strict(),
]);

type ParsedAction = z.infer<typeof actionSchema>;
const safeKeySuffix = (key: string) => key.replace(/[^A-Za-z0-9]/g, "").slice(-4).padStart(4, "•");

async function audit(actorId: string, action: string, outcome: "completed" | "failed", provider: ValProvider | null, metadata: Record<string, unknown> = {}, modelId: string | null = null, targetUserId: string | null = null) {
  const admin = getSupabaseAdminClient();
  await admin.from("val_ai_admin_audit_log").insert({
    actor_id: actorId, action, outcome, provider_id: provider, model_id: modelId,
    target_user_id: targetUserId, metadata,
  });
}

function responseError(message: string, status = 503, code?: string) {
  return NextResponse.json({ error: message, ...(code ? { code } : {}) }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET(request: NextRequest) {
  const master = await getVerifiedMaster(request.headers.get("authorization"));
  if (!master) return responseError("Não autorizado.", 401);
  const admin = getSupabaseAdminClient();
  const { day: today, month } = getValUsagePeriodStarts();
  const [providers, keys, models, settings, dayRows, monthRows, adminTestCosts, recentErrors, userUsage, users, overrides, auditRows, routerRuntime] = await Promise.all([
    admin.from("val_ai_providers").select("id, enabled, health_status, failure_count, circuit_open_until, priority, last_health_check, last_latency_ms, last_error_category, quota_headers, updated_at").eq("id", "deepseek"),
    admin.from("val_ai_provider_keys").select("id, provider_id, key_suffix, is_active, created_at, updated_at").eq("is_active", true).eq("provider_id", "deepseek"),
    admin.from("val_ai_models").select("id, provider_id, model_id, display_name, is_free, free_verified, free_evidence, is_enabled, priority, supports_chat, supports_tools, supports_structured_output, supports_reasoning, supports_streaming, context_window, health_status, last_health_check, last_success_at, last_failure_at, last_latency_ms, failure_count, circuit_open_until, official_prompt_price, official_completion_price, input_cost_per_million, output_cost_per_million, pricing_source, price_verified_at, daily_request_limit, monthly_request_limit, daily_token_limit, monthly_token_limit, catalog_seen_at").eq("provider_id", "deepseek"),
    admin.from("val_ai_runtime_settings").select("*").eq("id", 1).maybeSingle(),
    admin.from("val_ai_usage_rollups").select("period_kind, period_start, provider_id, model_id, user_id, requests, attempts, successes, failures, fallbacks, input_tokens, output_tokens, latency_total_ms, estimated_cost_usd").eq("period_kind", "day").eq("period_start", today).eq("provider_id", "deepseek"),
    admin.from("val_ai_usage_rollups").select("period_kind, period_start, provider_id, model_id, user_id, requests, attempts, successes, failures, fallbacks, input_tokens, output_tokens, latency_total_ms, estimated_cost_usd").eq("period_kind", "month").eq("period_start", month).eq("provider_id", "deepseek"),
    admin.from("val_ai_admin_test_events").select("estimated_cost_usd, created_at, provider_id").eq("provider_id", "deepseek").gte("created_at", `${month}T00:00:00-03:00`).order("created_at", { ascending: false }).limit(10000),
    admin.from("val_ai_usage_events").select("id, request_id, user_id, provider_id, model_id, task_type, attempt_index, status, error_category, provider_code, http_status, provider_request_id, latency_ms, created_at").eq("provider_id", "deepseek").eq("status", "FAILED").order("created_at", { ascending: false }).limit(30),
    admin.from("val_ai_user_quota_usage").select("user_id, period_kind, period_start, requests, tokens").in("period_kind", ["day", "month"]).in("period_start", [today, month]).order("requests", { ascending: false }).limit(1000),
    admin.from("profiles").select("id, full_name, username, account_status, account_role").eq("account_role", "user").order("full_name", { ascending: true }).limit(1000),
    admin.from("val_ai_user_quota_overrides").select("*"),
    admin.from("val_ai_admin_audit_log").select("id, actor_id, action, provider_id, model_id, target_user_id, outcome, metadata, created_at").or("provider_id.eq.deepseek,provider_id.is.null").order("created_at", { ascending: false }).limit(40),
    loadValRouterRuntime({ tools: true }),
  ]);
  const required = [providers, keys, models, settings, dayRows, monthRows, adminTestCosts, recentErrors, userUsage, users, overrides, auditRows];
  const failure = required.find((result) => result.error);
  if (failure?.error) {
    const diagnosis = diagnoseValAIAdminDatabaseError(failure.error);
    console.error("[val-ai-admin] Falha ao consultar a Central da Val", {
      code: diagnosis.code,
      databaseCode: failure.error.code || null,
      technical: diagnosis.technical,
    });
    return NextResponse.json({ error: diagnosis.message, code: diagnosis.code, technical: diagnosis.technical }, {
      status: 503,
      headers: { "Cache-Control": "no-store" },
    });
  }

  const sum = (rows: Array<Record<string, unknown>>) => rows.reduce<{ requests: number; successes: number; failures: number; fallbacks: number; tokens: number; latency: number; estimatedCostUsd: number }>((totals, row) => {
    totals.requests += Number(row.requests || 0); totals.successes += Number(row.successes || 0);
    totals.failures += Number(row.failures || 0); totals.fallbacks += Number(row.fallbacks || 0);
    totals.tokens += Number(row.input_tokens || 0) + Number(row.output_tokens || 0);
    totals.latency += Number(row.latency_total_ms || 0);
    totals.estimatedCostUsd += Number(row.estimated_cost_usd || 0);
    return totals;
  }, { requests: 0, successes: 0, failures: 0, fallbacks: 0, tokens: 0, latency: 0, estimatedCostUsd: 0 });
  const dayTotals = sum(dayRows.data || []); const monthTotals = sum(monthRows.data || []);
  const localDate = (value: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value));
  for (const test of adminTestCosts.data || []) {
    const testCost = Number(test.estimated_cost_usd || 0);
    monthTotals.estimatedCostUsd += testCost;
    if (localDate(String(test.created_at)) === today) dayTotals.estimatedCostUsd += testCost;
  }
  const userMap = new Map((users.data || []).map((user: Record<string, unknown>) => [String(user.id), user]));
  const overrideMap = new Map((overrides.data || []).map((override: Record<string, unknown>) => [String(override.user_id), override]));
  const userRows = [...new Set([...(userUsage.data || []).map((row: Record<string, unknown>) => String(row.user_id)), ...(users.data || []).map((user: Record<string, unknown>) => String(user.id))])]
    .map((id) => ({
      user: userMap.get(id) || { id, full_name: null, username: null, account_status: "unknown" },
      daily: {
        ...((userUsage.data || []).find((row: Record<string, unknown>) => String(row.user_id) === id && row.period_kind === "day" && row.period_start === today) || { requests: 0, tokens: 0 }),
        estimatedCostUsd: (dayRows.data || []).filter((row: Record<string, unknown>) => String(row.user_id) === id).reduce((total: number, row: Record<string, unknown>) => total + Number(row.estimated_cost_usd || 0), 0),
      },
      monthly: {
        ...((userUsage.data || []).find((row: Record<string, unknown>) => String(row.user_id) === id && row.period_kind === "month" && row.period_start === month) || { requests: 0, tokens: 0 }),
        estimatedCostUsd: (monthRows.data || []).filter((row: Record<string, unknown>) => String(row.user_id) === id).reduce((total: number, row: Record<string, unknown>) => total + Number(row.estimated_cost_usd || 0), 0),
      },
      override: overrideMap.get(id) || null,
    }));
  const readyModels = routerRuntime.candidates.filter((model) => !model.requiresProbe && !model.requiresProviderProbe);
  const usageByModel = new Map<string, Record<string, unknown>>();
  for (const row of [...(dayRows.data || []), ...(monthRows.data || [])]) {
    const key = `${row.period_kind}:${row.provider_id}:${row.model_id}`;
    const total = usageByModel.get(key) || { period: row.period_kind, provider: row.provider_id, model: row.model_id, requests: 0, attempts: 0, successes: 0, failures: 0, fallbacks: 0, tokens: 0, latency: 0, estimatedCostUsd: 0 };
    total.requests = Number(total.requests) + Number(row.requests || 0);
    total.attempts = Number(total.attempts) + Number(row.attempts || 0);
    total.successes = Number(total.successes) + Number(row.successes || 0);
    total.failures = Number(total.failures) + Number(row.failures || 0);
    total.fallbacks = Number(total.fallbacks) + Number(row.fallbacks || 0);
    total.tokens = Number(total.tokens) + Number(row.input_tokens || 0) + Number(row.output_tokens || 0);
    total.latency = Number(total.latency) + Number(row.latency_total_ms || 0);
    total.estimatedCostUsd = Number(total.estimatedCostUsd) + Number(row.estimated_cost_usd || 0);
    usageByModel.set(key, total);
  }
  return NextResponse.json({
    providers: providers.data,
    keys: keys.data,
    models: models.data,
    settings: settings.data,
    overview: {
      status: getValServiceStatus(routerRuntime.enabled, routerRuntime.candidates),
      requestsToday: dayTotals.requests, requestsMonth: monthTotals.requests,
      tokensToday: dayTotals.tokens, tokensMonth: monthTotals.tokens,
      estimatedCostTodayUsd: dayTotals.estimatedCostUsd, estimatedCostMonthUsd: monthTotals.estimatedCostUsd,
      successRate: dayTotals.requests ? Math.round(dayTotals.successes / Math.max(1, dayTotals.successes + dayTotals.failures) * 100) : null,
      failuresToday: dayTotals.failures, fallbacksToday: dayTotals.fallbacks,
      activeProviders: (providers.data || []).filter((item: Record<string, unknown>) => item.enabled).length,
      readyModels: readyModels.length, averageLatencyMs: dayTotals.requests ? Math.round(dayTotals.latency / dayTotals.requests) : null,
      uniqueUsersToday: new Set((dayRows.data || []).filter((row: Record<string, unknown>) => Number(row.requests) > 0).map((row: Record<string, unknown>) => row.user_id)).size,
    },
    recentErrors: recentErrors.data,
    usageByModel: [...usageByModel.values()],
    users: userRows,
    audit: auditRows.data,
    quotaSource: "Uso medido pelo Valurise; quotas reportadas por provider aparecem separadamente quando disponíveis.",
  }, { headers: { "Cache-Control": "no-store" } });
}

async function fetchModelById(provider: ValProvider, modelId: string) {
  const admin = getSupabaseAdminClient();
  const [{ data: model, error: modelError }, { data: providerRow, error: providerError }] = await Promise.all([
    admin.from("val_ai_models").select("*").eq("provider_id", provider).eq("model_id", modelId).maybeSingle(),
    admin.from("val_ai_providers").select("*").eq("id", provider).maybeSingle(),
  ]);
  if (modelError || providerError || !model || !providerRow) return null;
  return { model, providerRow };
}

function adminCandidate(provider: ValProvider, row: Record<string, unknown>): ValModelCandidate {
  return {
    provider, modelId: String(row.model_id), isFree: row.is_free === true, freeVerified: row.free_verified === true,
    enabled: row.is_enabled === true, supportsChat: row.supports_chat === true, supportsTools: row.supports_tools === true,
    supportsStructuredOutput: row.supports_structured_output === true, supportsReasoning: row.supports_reasoning === true,
    contextWindow: row.context_window === null ? null : Number(row.context_window),
    health: String(row.health_status || "UNAVAILABLE") as ValModelCandidate["health"],
    circuitOpenUntil: row.circuit_open_until ? String(row.circuit_open_until) : null,
    priority: Number(row.priority || 100), latencyMs: null,
    successRate: null, quotaRemainingRatio: null, providerEnabled: false,
    inputCostPerMillion: row.input_cost_per_million === null ? null : Number(row.input_cost_per_million),
    outputCostPerMillion: row.output_cost_per_million === null ? null : Number(row.output_cost_per_million),
  };
}

export async function POST(request: NextRequest) {
  const master = await getVerifiedMaster(request.headers.get("authorization"));
  if (!master) return responseError("Não autorizado.", 401);
  const body = await request.json().catch(() => null);
  const parsed = actionSchema.safeParse(body);
  if (!parsed.success) return responseError("Ação administrativa inválida.", 400, "INVALID_ADMIN_ACTION");
  const action = parsed.data;
  const admin = getSupabaseAdminClient();
  const auditAction = action.action;
  const auditProvider: ValProvider | null = "provider" in action ? action.provider : null;
  const auditModel: string | null = "modelId" in action ? action.modelId : null;
  const auditTarget: string | null = action.action === "set_user_override" ? action.userId : null;
  let auditMetadata: Record<string, unknown> = {};
  try {
    if (action.action === "save_key") {
      const { error: seedError } = await admin.from("val_ai_providers").upsert({ id: action.provider }, { onConflict: "id", ignoreDuplicates: true });
      if (seedError) throw new Error("Não foi possível preparar o provedor.");
      const { data: previousKey, error: previousKeyError } = await admin.from("val_ai_provider_keys").select("id").eq("provider_id", action.provider).eq("is_active", true).maybeSingle();
      if (previousKeyError) throw new Error("Não foi possível validar a chave ativa.");
      const disabledAt = new Date().toISOString();
      const [{ error: disableProviderError }, { error: disableModelsError }] = await Promise.all([
        admin.from("val_ai_providers").update({ enabled: false, health_status: "DISABLED", failure_count: 0, circuit_open_until: null, quota_headers: {}, updated_at: disabledAt }).eq("id", action.provider),
        admin.from("val_ai_models").update({ is_enabled: false, health_status: "DISABLED", updated_at: disabledAt }).eq("provider_id", action.provider),
      ]);
      if (disableProviderError || disableModelsError) throw new Error("O provedor foi mantido bloqueado porque não foi possível preparar uma rotação segura da chave.");
      const { data: created, error: insertError } = await admin.from("val_ai_provider_keys").insert({
        provider_id: action.provider, encrypted_api_key: encryptPersonalAiKey(action.apiKey),
        key_suffix: safeKeySuffix(action.apiKey), is_active: false, created_by: master.id,
      }).select("id").single();
      if (insertError || !created) throw new Error("Não foi possível criptografar e guardar a chave.");
      const { error: deactivateError } = await admin.from("val_ai_provider_keys").update({ is_active: false, updated_at: new Date().toISOString() }).eq("provider_id", action.provider).eq("is_active", true);
      if (deactivateError) { await admin.from("val_ai_provider_keys").delete().eq("id", created.id); throw new Error("Não foi possível trocar a chave ativa."); }
      const { error: activateError } = await admin.from("val_ai_provider_keys").update({ is_active: true, updated_at: new Date().toISOString() }).eq("id", created.id);
      if (activateError) {
        if (previousKey?.id) await admin.from("val_ai_provider_keys").update({ is_active: true, updated_at: new Date().toISOString() }).eq("id", previousKey.id);
        await admin.from("val_ai_provider_keys").delete().eq("id", created.id);
        throw new Error("A chave foi protegida, mas a rotação não concluiu; a chave anterior foi preservada quando disponível.");
      }
      auditMetadata = { suffix: safeKeySuffix(action.apiKey), rotated: true };
      await audit(master.id, auditAction, "completed", action.provider, auditMetadata);
      return NextResponse.json({ ok: true, key: { configured: true, suffix: safeKeySuffix(action.apiKey) } }, { headers: { "Cache-Control": "no-store" } });
    }
    if (action.action === "remove_key") {
      const { error } = await admin.from("val_ai_provider_keys").delete().eq("provider_id", action.provider);
      if (error) throw new Error("Não foi possível remover a chave protegida.");
      await admin.from("val_ai_providers").update({ enabled: false, health_status: "DISABLED", failure_count: 0, circuit_open_until: null, updated_at: new Date().toISOString() }).eq("id", action.provider);
      await admin.from("val_ai_models").update({ is_enabled: false, health_status: "DISABLED", updated_at: new Date().toISOString() }).eq("provider_id", action.provider);
      auditMetadata = { removed: true };
    } else if (action.action === "set_provider") {
      if (action.enabled) {
        if (!await loadValProviderKey(action.provider)) return responseError("Cadastre uma chave protegida antes de habilitar o provedor.", 409, "PROVIDER_KEY_MISSING");
      }
      const patch = {
        id: action.provider, enabled: action.enabled,
        health_status: action.enabled ? "DEGRADED" : "DISABLED", failure_count: 0, circuit_open_until: null, updated_at: new Date().toISOString(),
      };
      const { error } = await admin.from("val_ai_providers").upsert(patch, { onConflict: "id" });
      if (error) throw new Error("Não foi possível atualizar o estado do provedor.");
      const { error: modelHealthError } = await admin.from("val_ai_models").update({ health_status: action.enabled ? "DEGRADED" : "DISABLED", updated_at: new Date().toISOString() }).eq("provider_id", action.provider).eq("is_enabled", true);
      if (modelHealthError) throw new Error("O estado do provedor mudou, mas não foi possível atualizar a saúde dos modelos.");
      auditMetadata = { enabled: action.enabled };
    } else if (action.action === "refresh_catalog") {
      const apiKey = await loadValProviderKey(action.provider);
      if (!apiKey) return responseError("Cadastre uma chave do provedor antes de atualizar o catálogo.", 409, "PROVIDER_KEY_MISSING");
      const { models: discovered, quotaHeaders } = await discoverModelCatalog(action.provider, apiKey, AbortSignal.timeout(12_000));
      const { error: providerUpdateError } = await admin.from("val_ai_providers").update({ quota_headers: quotaHeaders, updated_at: new Date().toISOString() }).eq("id", action.provider);
      if (providerUpdateError) throw new Error("Catálogo recebido, mas não foi possível guardar metadados de cota.");
      const { data: previous } = await admin.from("val_ai_models").select("*").eq("provider_id", action.provider);
      const previousById = new Map((previous || []).map((row: Record<string, unknown>) => [String(row.model_id), row]));
      const seen = new Set<string>();
      const catalogRows: Record<string, unknown>[] = [];
      for (const item of discovered) {
        seen.add(item.model_id);
        const old = previousById.get(item.model_id);
        const patch = {
          provider_id: action.provider, model_id: item.model_id, display_name: item.display_name,
          is_free: false, free_verified: false, free_evidence: null,
          is_enabled: Boolean(old?.is_enabled && item.supports_chat), priority: old?.priority || 100,
          supports_chat: item.supports_chat, supports_tools: old?.supports_tools === true,
          supports_structured_output: old?.supports_structured_output === true, supports_reasoning: old?.supports_reasoning === true,
          supports_streaming: old?.supports_streaming !== false, context_window: item.context_window,
          official_prompt_price: item.official_prompt_price ?? old?.official_prompt_price ?? null, official_completion_price: item.official_completion_price ?? old?.official_completion_price ?? null,
          input_cost_per_million: old?.input_cost_per_million ?? null, output_cost_per_million: old?.output_cost_per_million ?? null,
          pricing_source: old?.pricing_source ?? null, price_verified_at: old?.price_verified_at ?? null,
          health_status: old?.is_enabled ? old?.health_status : "UNAVAILABLE", catalog_seen_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        };
        catalogRows.push(patch);
      }
      for (let offset = 0; offset < catalogRows.length; offset += 100) {
        const { error } = await admin.from("val_ai_models").upsert(catalogRows.slice(offset, offset + 100), { onConflict: "provider_id,model_id" });
        if (error) throw new Error("Não foi possível salvar o catálogo descoberto.");
      }
      for (const old of previous || []) if (!seen.has(String(old.model_id)) && (old.is_enabled || old.free_verified)) {
        const { error } = await admin.from("val_ai_models").update({
          is_enabled: false, health_status: "UNAVAILABLE", free_verified: false,
          free_evidence: null, updated_at: new Date().toISOString(),
        }).eq("id", old.id);
        if (error) throw new Error("Um modelo ausente no catálogo não pôde ser removido da allowlist.");
      }
      auditMetadata = { discovered: discovered.length };
    } else if (action.action === "update_model") {
      const current = await fetchModelById(action.provider, action.modelId);
      if (!current) return responseError("Atualize o catálogo antes de alterar este modelo.", 404, "MODEL_NOT_CATALOGUED");
      if (action.provider === "deepseek" && action.isFree) return responseError("DeepSeek é um provider pago; mantenha esta classificação como paga.", 409, "MODEL_FREE_CLASSIFICATION_INVALID");
      if (action.enabled && !current.model.supports_chat) return responseError("Somente modelos compatíveis com chat podem ser habilitados.", 400, "MODEL_CAPABILITY_BLOCKED");
      if (action.enabled && (action.inputCostPerMillion === null || action.outputCostPerMillion === null)) return responseError("Informe o custo central por milhão de tokens antes de habilitar este modelo; o limite global de gastos depende dessa estimativa.", 409, "MODEL_PRICING_REQUIRED");
      const { error } = await admin.from("val_ai_models").update({
        is_free: action.isFree, free_verified: action.isFree,
        free_evidence: null,
        is_enabled: action.enabled, priority: action.priority, supports_tools: action.supportsTools,
        supports_structured_output: action.supportsStructuredOutput, supports_reasoning: action.supportsReasoning,
        input_cost_per_million: action.inputCostPerMillion, output_cost_per_million: action.outputCostPerMillion,
        pricing_source: action.inputCostPerMillion !== null && action.outputCostPerMillion !== null ? "Configured by Super Admin" : null,
        price_verified_at: action.inputCostPerMillion !== null && action.outputCostPerMillion !== null ? new Date().toISOString() : null,
        daily_request_limit: action.dailyRequestLimit, monthly_request_limit: action.monthlyRequestLimit,
        daily_token_limit: action.dailyTokenLimit, monthly_token_limit: action.monthlyTokenLimit,
        health_status: action.enabled ? "DEGRADED" : "DISABLED", updated_at: new Date().toISOString(),
      }).eq("id", current.model.id);
      if (error) throw new Error("O modelo não foi atualizado.");
      auditMetadata = { isFree: action.isFree, enabled: action.enabled, priority: action.priority, tools: action.supportsTools, inputCostPerMillion: action.inputCostPerMillion, outputCostPerMillion: action.outputCostPerMillion };
    } else if (action.action === "test_model") {
      const current = await fetchModelById(action.provider, action.modelId);
      if (!current || current.model.is_enabled !== true || current.model.supports_chat !== true) return responseError("Habilite um modelo de chat antes de testar a conexão.", 409, "MODEL_NOT_ENABLED");
      if (current.providerRow.enabled !== true) return responseError("Ative a DeepSeek no roteamento antes de testar.", 409, "PROVIDER_DISABLED");
      const [{ data: runtimeSettings }, apiKey] = await Promise.all([
        admin.from("val_ai_runtime_settings").select("val_enabled, val_router_enabled, val_deepseek_enabled, monthly_cost_hard_limit_usd").eq("id", 1).maybeSingle(),
        loadValProviderKey(action.provider),
      ]);
      if (!runtimeSettings?.val_enabled || !runtimeSettings.val_router_enabled || !runtimeSettings.val_deepseek_enabled) return responseError("Ative a Val e o roteador antes do teste.", 409, "VAL_ROUTER_DISABLED");
      if (!apiKey) return responseError("Cadastre a chave protegida deste provedor antes de testar.", 409, "PROVIDER_KEY_MISSING");
      const requestId = randomUUID();
      const candidate = { ...adminCandidate(action.provider, current.model), providerEnabled: true, apiKey, displayName: String(current.model.display_name) };
      const requiresTools = current.model.supports_tools === true;
      if (!isApprovedValModel(candidate, { tools: requiresTools })) return responseError("O provider, o modelo, o estado de saúde ou a capacidade necessária bloqueia o teste.", 409, "VAL_MODEL_POLICY_BLOCKED");
      const costEstimateUsd = estimateValRequestCostUsd({ inputTokens: 64, outputTokens: requiresTools ? 32 : 8, inputCostPerMillion: candidate.inputCostPerMillion, outputCostPerMillion: candidate.outputCostPerMillion });
      if (costEstimateUsd === null) return responseError("Configure o custo do modelo antes de testar para manter o limite global de gastos.", 409, "MODEL_PRICING_REQUIRED");
      const { data: costReservation, error: costReservationError } = await admin.rpc("reserve_val_ai_global_cost", { p_request_id: requestId, p_estimated_cost_usd: costEstimateUsd });
      if (costReservationError || !costReservation?.allowed) return responseError("O teste não foi enviado porque o limite global de gastos foi atingido ou não pôde ser verificado.", 409, "GLOBAL_COST_LIMIT");
      const startedAt = Date.now();
      let result: {
        text: string;
        steps: Array<{ toolCalls: Array<{ toolName: string }> }>;
        usage: { inputTokens?: number; outputTokens?: number };
        response: { headers: Headers };
      } | null = null;
      let failure: ReturnType<typeof classifyAIError> | { category: string; httpStatus: null; providerCode: string; providerMessage: null; requestId: null } | null = null;
      try {
        const generated = await generateText({
          model: await createValModel(candidate, requiresTools),
          prompt: getValHealthCheckPrompt(requiresTools),
          ...(requiresTools ? { tools: { [VAL_HEALTH_CHECK_TOOL_NAME]: tool({ description: VAL_HEALTH_CHECK_TOOL_DESCRIPTION, inputSchema: z.object({}).strict(), execute: async () => ({ ok: true }) }) }, toolChoice: "required" as const } : {}),
          maxOutputTokens: requiresTools ? 32 : 8, temperature: 0, maxRetries: 0, timeout: 12_000, abortSignal: AbortSignal.timeout(13_000),
        });
        result = generated as unknown as NonNullable<typeof result>;
        if (!isValHealthCheckSuccessful(generated, requiresTools)) throw new Error(requiresTools ? "TOOL_CALL_UNSUPPORTED" : "EMPTY_RESPONSE");
      } catch (error) {
        failure = error instanceof Error && error.message === "TOOL_CALL_UNSUPPORTED"
          ? { category: "TOOL_CALL_UNSUPPORTED", httpStatus: null, providerCode: "TOOL_CALL_NOT_CONFIRMED", providerMessage: null, requestId: null }
          : classifyAIError(error, action.provider, action.modelId);
      }
      const measuredResult = result as {
        usage: { inputTokens?: number; outputTokens?: number };
        response: { headers: Headers };
      } | null;
      const latencyMs = Date.now() - startedAt;
      const quotaHeaders = measuredResult ? readSafeQuotaHeaders(new Headers(measuredResult.response.headers)) : {};
      const actualCost = measuredResult ? estimateValRequestCostUsd({ inputTokens: measuredResult.usage.inputTokens ?? 64, outputTokens: measuredResult.usage.outputTokens ?? (requiresTools ? 32 : 8), inputCostPerMillion: candidate.inputCostPerMillion, outputCostPerMillion: candidate.outputCostPerMillion }) ?? costEstimateUsd : costEstimateUsd;
      await admin.from("val_ai_admin_test_events").insert({ request_id: requestId, actor_id: master.id, provider_id: action.provider, model_id: action.modelId, status: failure ? "FAILED" : "SUCCESS", input_tokens: measuredResult?.usage.inputTokens ?? null, output_tokens: measuredResult?.usage.outputTokens ?? null, estimated_cost_usd: actualCost, latency_ms: latencyMs, error_category: failure?.category || null });
      await admin.rpc("record_val_ai_model_result", { p_provider_id: action.provider, p_model_id: action.modelId, p_success: !failure, p_latency_ms: latencyMs, p_error_category: failure?.category || null, p_error_code: failure?.providerCode || null, p_quota_headers: quotaHeaders });
      await admin.rpc("finalize_val_ai_global_cost", { p_request_id: requestId });
      auditMetadata = { requestId, latencyMs, toolCallValidated: !failure && requiresTools, estimatedCostUsd: actualCost, inputTokens: measuredResult?.usage.inputTokens ?? null, outputTokens: measuredResult?.usage.outputTokens ?? null, failed: Boolean(failure), category: failure?.category || null, httpStatus: failure?.httpStatus || null, providerCode: failure?.providerCode || null };
      await audit(master.id, auditAction, failure ? "failed" : "completed", action.provider, auditMetadata, action.modelId);
      if (failure) return NextResponse.json({ ok: false, requestId, provider: action.provider, model: action.modelId, latencyMs, error: failure.category === "TOOL_CALL_UNSUPPORTED" ? "Este modelo não confirmou a capacidade de ferramentas necessária à Val." : "A conexão não foi validada. Consulte a categoria e o código seguros abaixo.", category: failure.category, httpStatus: failure.httpStatus, providerCode: failure.providerCode || null, providerMessage: failure.providerMessage || null, providerRequestId: failure.requestId || null }, { status: 502, headers: { "Cache-Control": "no-store" } });
      return NextResponse.json({ ok: true, requestId, provider: action.provider, model: action.modelId, latencyMs, toolCallValidated: requiresTools, usage: { inputTokens: measuredResult?.usage.inputTokens ?? null, outputTokens: measuredResult?.usage.outputTokens ?? null }, estimatedCostUsd: actualCost, quotaHeaders }, { headers: { "Cache-Control": "no-store" } });
    } else if (action.action === "save_limits") {
      const { error } = await admin.from("val_ai_runtime_settings").upsert({
        id: 1, daily_requests: action.dailyRequests, monthly_requests: action.monthlyRequests,
      daily_tokens: action.dailyTokens, monthly_tokens: action.monthlyTokens,
      max_context_tokens: action.maxContextTokens, max_output_tokens: action.maxOutputTokens,
      max_attempts: action.maxAttempts, circuit_failure_threshold: action.circuitFailureThreshold,
      circuit_cooldown_seconds: action.circuitCooldownSeconds, val_enabled: action.valEnabled, val_router_enabled: action.routerEnabled,
      soft_quota_percent: action.softQuotaPercent, deprioritize_quota_percent: action.deprioritizeQuotaPercent, hard_quota_percent: action.hardQuotaPercent,
        monthly_cost_soft_limit_usd: action.monthlyCostSoftLimitUsd, monthly_cost_hard_limit_usd: action.monthlyCostHardLimitUsd, reference_balance_usd: action.referenceBalanceUsd,
        val_deepseek_enabled: action.deepseekEnabled, val_fallback_enabled: action.fallbackEnabled,
        val_actions_enabled: action.actionsEnabled, val_insights_enabled: action.insightsEnabled,
        updated_by: master.id, updated_at: new Date().toISOString(),
      }, { onConflict: "id" });
      if (error) throw new Error("Não foi possível salvar limites e controles gerais.");
      auditMetadata = { dailyRequests: action.dailyRequests, monthlyRequests: action.monthlyRequests, monthlyCostSoftLimitUsd: action.monthlyCostSoftLimitUsd, monthlyCostHardLimitUsd: action.monthlyCostHardLimitUsd, referenceBalanceConfigured: action.referenceBalanceUsd !== null, maxAttempts: action.maxAttempts, circuitFailureThreshold: action.circuitFailureThreshold, circuitCooldownSeconds: action.circuitCooldownSeconds, valEnabled: action.valEnabled, deepseekEnabled: action.deepseekEnabled, fallbackEnabled: action.fallbackEnabled };
    } else if (action.action === "set_user_override") {
      const { error } = await admin.from("val_ai_user_quota_overrides").upsert({
        user_id: action.userId, is_blocked: action.blocked, daily_requests: action.dailyRequests,
        monthly_requests: action.monthlyRequests, daily_tokens: action.dailyTokens, monthly_tokens: action.monthlyTokens,
        max_context_tokens: action.maxContextTokens, max_output_tokens: action.maxOutputTokens,
        updated_by: master.id, updated_at: new Date().toISOString(),
      }, { onConflict: "user_id" });
      if (error) throw new Error("Não foi possível salvar os limites deste usuário.");
      auditMetadata = { blocked: action.blocked, dailyRequests: action.dailyRequests, monthlyRequests: action.monthlyRequests };
    }
    await audit(master.id, auditAction, "completed", auditProvider, auditMetadata, auditModel, auditTarget);
    return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    await audit(master.id, auditAction, "failed", auditProvider, { failure: error instanceof Error ? error.message.slice(0, 120) : "unknown" }, auditModel, auditTarget);
    return responseError(error instanceof Error ? error.message : "A operação não foi concluída.", 503, "VAL_AI_ADMIN_OPERATION_FAILED");
  }
}
