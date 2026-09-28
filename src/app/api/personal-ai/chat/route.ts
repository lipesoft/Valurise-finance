import { randomUUID, createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { ToolLoopAgent, isStepCount, type ToolSet } from "ai";
import { z } from "zod";
import { createBusinessFinanceTools, createPersonalFinanceTools } from "@/lib/personal-ai/tools";
import { formatValResponse } from "@/lib/personal-ai/presentation";
import { createPersonalAiTransactionProposalTool, type PersonalAiTransactionDraft } from "@/lib/personal-ai/actions";
import { NO_FINANCIAL_CONTEXT_INSTRUCTION, requestsTransactionAction, requiresPersonalFinanceData, VAL_PERSONA } from "@/lib/personal-ai";
import { AIProviderError, classifyAIError } from "@/lib/personal-ai/providers";
import { createValModel } from "@/lib/val-ai/adapter";
import { discoverFreeModelCatalog, readSafeQuotaHeaders } from "@/lib/val-ai/provider-catalog";
import { verifyCurrentFreeCatalogEntry } from "@/lib/val-ai/catalog-policy";
import { classifyValTask, runFreeModelCandidates, selectFreeModels, type ValProvider } from "@/lib/val-ai/policy";
import { loadValRouterRuntime, valFeatureIsEnabled, type RoutedModel } from "@/lib/val-ai/router";
import { recordValAiAttempt, recordValAiBlockedRequest, recordValAiModelHealth } from "@/lib/val-ai/telemetry";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getVerifiedWorkspaceContext } from "@/lib/workspaces/server";
import { createUserScopedSupabaseClient } from "@/lib/supabase/user-scoped";
import { legalVersions } from "@/lib/legal-content";
import { BUSINESS_ASSUMPTION_KEYS, type BusinessAssumption } from "@/lib/business-finance";

export const maxDuration = 30;

const schema = z.object({
  messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().trim().min(1).max(2000) }).strict()).min(1).max(12),
  clientRequestId: z.string().uuid().optional(),
}).strict();

function bearerToken(request: NextRequest) {
  return request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim() || "";
}

function unavailable() {
  return NextResponse.json({ error: "A Val está temporariamente indisponível. Tente novamente em alguns instantes." }, { status: 503, headers: { "Cache-Control": "no-store" } });
}

function quotaMessage(reason: string) {
  if (reason === "USER_BLOCKED") return "O acesso à Val está temporariamente pausado para esta conta. Fale com o suporte.";
  if (reason === "TOKEN_LIMIT") return "Você atingiu o limite de uso da Val por hoje ou neste mês. Seu acesso será renovado automaticamente.";
  return "Você atingiu o limite de consultas da Val por hoje ou neste mês. Seu acesso será renovado automaticamente.";
}

function errorCategory(error: unknown) {
  return error && typeof error === "object" && "category" in error ? String(error.category) : "UNKNOWN_PROVIDER_ERROR";
}

function requestTaskText(messages: Array<{ role: "user" | "assistant"; content: string }>) {
  return messages.filter((message) => message.role === "user").slice(-3).map((message) => message.content).join("\n");
}

export async function GET(request: NextRequest) {
  const token = bearerToken(request);
  const active = await getVerifiedWorkspaceContext(request.headers.get("authorization"), request.headers.get("x-valurise-workspace-id"));
  if (!active.ok) return NextResponse.json({ error: active.error }, { status: active.status });
  const { user, workspace } = active;
  try {
    const scoped = createUserScopedSupabaseClient(token);
    const { data, error } = await scoped.from("personal_ai_messages")
      .select("id, role, content")
      .eq("workspace_id", workspace.id)
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(24);
    if (error) return NextResponse.json({ error: "Não foi possível carregar a conversa." }, { status: 500 });
    return NextResponse.json({ messages: [...(data || [])].reverse() });
  } catch {
    return NextResponse.json({ error: "Não foi possível carregar a conversa." }, { status: 503 });
  }
}

export async function POST(request: NextRequest) {
  const authorization = request.headers.get("authorization");
  const token = bearerToken(request);
  const active = await getVerifiedWorkspaceContext(authorization, request.headers.get("x-valurise-workspace-id"));
  if (!active.ok) return NextResponse.json({ error: active.error }, { status: active.status });
  const { user, workspace } = active;
  if (Number(request.headers.get("content-length") || 0) > 32_000) return NextResponse.json({ error: "A conversa excede o tamanho permitido." }, { status: 413 });
  const rawBody = await request.text().catch(() => "");
  if (rawBody.length > 32_000) return NextResponse.json({ error: "A conversa excede o tamanho permitido." }, { status: 413 });
  let body: unknown = null;
  try { body = JSON.parse(rawBody); } catch { return NextResponse.json({ error: "Mensagem inválida." }, { status: 400 }); }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Mensagem inválida." }, { status: 400 });
  const current = [...parsed.data.messages].reverse().find((item) => item.role === "user");
  if (!current) return NextResponse.json({ error: "Envie uma pergunta para a Val." }, { status: 400 });

  const admin = getSupabaseAdminClient();
  const requestId = parsed.data.clientRequestId || randomUUID();
  const rateKey = createHash("sha256").update(`central-val-ai\0${user.id}\0${workspace.id}`).digest("hex");
  const { data: allowed, error: rateError } = await admin.rpc("consume_public_rate_limit", { p_key: rateKey, p_max_attempts: 40, p_window_seconds: 3600 });
  if (rateError) {
    console.error("Central Val AI request guard unavailable", JSON.stringify({ code: rateError.code || "UNKNOWN" }));
    return unavailable();
  }
  if (allowed !== true) return NextResponse.json({ error: "Você enviou muitas consultas em pouco tempo. Aguarde um pouco e tente novamente." }, { status: 429, headers: { "Retry-After": "3600" } });

  const [{ data: consent, error: consentError }, { data: preference, error: preferenceError }, { data: override }] = await Promise.all([
    admin.from("workspace_ai_consents").select("ai_data_sharing_version, accepted_at").eq("user_id", user.id).eq("workspace_id", workspace.id).maybeSingle(),
    admin.from("val_ai_user_preferences").select("actions_enabled").eq("user_id", user.id).eq("workspace_id", workspace.id).maybeSingle(),
    admin.from("val_ai_user_quota_overrides").select("max_context_tokens, max_output_tokens, is_blocked").eq("user_id", user.id).maybeSingle(),
  ]);
  if (consentError || preferenceError) return unavailable();
  const runtime = await loadValRouterRuntime({});
  if (!runtime.enabled || !runtime.settings) return unavailable();
  const canUseFinancialContext = Boolean(valFeatureIsEnabled(runtime.settings, "insights")
    && consent?.ai_data_sharing_version === legalVersions.aiSharing && consent.accepted_at);
  const actionsEnabled = Boolean(canUseFinancialContext && preference?.actions_enabled && valFeatureIsEnabled(runtime.settings, "actions"));
  const taskText = requestTaskText(parsed.data.messages);
  const requestsAction = actionsEnabled && requestsTransactionAction(taskText);
  const currentNeedsData = canUseFinancialContext && (requiresPersonalFinanceData(parsed.data.messages) || requestsAction);
  const taskType = classifyValTask(taskText, currentNeedsData, requestsAction);
  const scoped = createUserScopedSupabaseClient(token);
  const priorMessages = canUseFinancialContext
    ? await scoped.from("personal_ai_messages").select("role, content").eq("workspace_id", workspace.id).eq("user_id", user.id).order("created_at", { ascending: false }).limit(10)
    : { data: [], error: null };
  if (priorMessages.error) return NextResponse.json({ error: "Não foi possível carregar o histórico autorizado da conversa." }, { status: 503 });
  const history = [...(priorMessages.data || [])].reverse().map((item) => ({ role: item.role as "user" | "assistant", content: item.content }));
  const lastSaved = history.at(-1);
  const conversation = lastSaved?.role === "user" && lastSaved.content === current.content
    ? history
    : [...history, { role: "user" as const, content: current.content }];

  const workspaceInstructions = canUseFinancialContext
    ? workspace.type === "business"
      ? "CONTEXTO ATIVO: workspace empresarial. Responda apenas sobre os dados deste workspace empresarial. Diferencie receitas e despesas registradas (realizadas) de valores informados, estimados e projetados; preserve a natureza e a origem devolvidas pelas ferramentas. Diga “dados insuficientes” quando algum componente estiver ausente; ausência não significa R$ 0. Use “resultado gerencial estimado/misto”, nunca “lucro” contábil ou fiscal se a base incluir estimativas. As contas a receber/pagar e as projeções são referências gerenciais, não títulos ou compromissos itemizados. Nunca misture ou suponha dados pessoais do titular."
      : "CONTEXTO ATIVO: workspace pessoal. Responda somente sobre as finanças pessoais presentes neste workspace."
    : `MODO ATIVO: ${workspace.type === "business" ? "empresarial" : "pessoal"}. Não há consentimento para consultar dados financeiros deste workspace.`;
  let createdProposals: Array<{
    id: string; action_type: "income" | "expense"; amount_cents: number;
    category: string; account_label: string; description: string;
    transaction_date: string; expires_at: string;
  }> = [];

  let financialTools: ToolSet = {};
  let financialState: Record<string, unknown> | null = null;
  if (canUseFinancialContext && currentNeedsData) {
    const { data: financial, error: financialError } = await scoped.from("user_financial_state").select("state, version").eq("workspace_id", workspace.id).maybeSingle();
    if (financialError) return NextResponse.json({ error: "Não foi possível consultar os dados financeiros com segurança." }, { status: 503 });
    financialState = (financial?.state || {}) as Record<string, unknown>;
    const readTools = createPersonalFinanceTools(financialState);
    const businessTools = workspace.type === "business" ? createBusinessFinanceTools(financialState, async (period) => {
      const referenceMonth = `${period}-01`;
      const results = await Promise.all(BUSINESS_ASSUMPTION_KEYS.map((metricKey) => scoped
        .from("business_financial_assumptions").select("metric_key, amount_cents, nature, source, reference_month, is_cleared, created_at")
        .eq("workspace_id", workspace.id).eq("metric_key", metricKey).lte("reference_month", referenceMonth)
        .order("reference_month", { ascending: false }).order("created_at", { ascending: false }).limit(1).maybeSingle()));
      if (results.some((result) => result.error)) throw new Error("Business financial context is unavailable.");
      return results.flatMap((result) => {
        const row = result.data;
        if (!row || row.is_cleared || !Number.isSafeInteger(Number(row.amount_cents))) return [];
        return [{ metricKey: row.metric_key, amountCents: Number(row.amount_cents), nature: row.nature, source: row.source, referenceMonth: row.reference_month, createdAt: row.created_at } as BusinessAssumption];
      });
    }) : {};
    if (actionsEnabled && requestsAction && workspace.type === "personal" && financial && Number.isInteger(financial.version)) {
      let proposalCreated = false;
      const proposalTool = createPersonalAiTransactionProposalTool(financialState, async (draft: PersonalAiTransactionDraft) => {
        if (proposalCreated) throw new Error("Preparei uma proposta por vez para você revisar.");
        const { data: existingByRequest } = await admin.from("personal_ai_action_proposals")
          .select("id, action_type, amount_cents, category, account_label, description, transaction_date, expires_at")
          .eq("request_id", requestId).eq("workspace_id", workspace.id).eq("user_id", user.id).maybeSingle();
        if (existingByRequest) {
          proposalCreated = true;
          createdProposals = [{ ...existingByRequest, amount_cents: Number(existingByRequest.amount_cents) }];
          return { id: existingByRequest.id, expiresAt: existingByRequest.expires_at };
        }
        const { count, error: countError } = await admin.from("personal_ai_action_proposals").select("id", { count: "exact", head: true })
          .eq("workspace_id", workspace.id).eq("user_id", user.id).eq("status", "pending").gt("expires_at", new Date().toISOString());
        if (countError) throw new Error("Não foi possível verificar propostas pendentes.");
        if ((count || 0) >= 5) throw new Error("Você já tem várias propostas aguardando revisão. Confirme ou descarte uma antes de pedir outra.");
        const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
        const { data: proposal, error: insertError } = await admin.from("personal_ai_action_proposals").insert({
          request_id: requestId, user_id: user.id, workspace_id: workspace.id, consent_version: legalVersions.aiSharing,
          action_type: draft.type, amount_cents: draft.amountCents, category: draft.category,
          account_label: draft.account, description: draft.description, transaction_date: draft.date,
          expected_state_version: financial.version, expires_at: expiresAt,
        }).select("id, action_type, amount_cents, category, account_label, description, transaction_date, expires_at").single();
        if (insertError || !proposal) throw new Error("Não foi possível preparar a proposta para sua revisão.");
        proposalCreated = true;
        createdProposals = [{ ...proposal, amount_cents: Number(proposal.amount_cents) }];
        return { id: proposal.id, expiresAt: proposal.expires_at };
      });
      financialTools = { ...readTools, ...businessTools, createTransactionProposal: proposalTool };
    } else {
      financialTools = { ...readTools, ...businessTools };
    }
  }

  const maxAttempts = Number(runtime.settings.max_attempts || 2);
  const maxContextTokens = Math.min(Number(override?.max_context_tokens || runtime.settings.max_context_tokens || 12000), 1000000);
  const maxOutputTokens = Math.max(16, Math.min(Number(override?.max_output_tokens || runtime.settings.max_output_tokens || 700), 32000, maxContextTokens - 250));
  const reservedPromptTokens = Math.ceil((workspaceInstructions.length + VAL_PERSONA.length + 3000) / 4);
  const maxConversationChars = Math.max(0, (maxContextTokens - maxOutputTokens - reservedPromptTokens) * 4);
  const boundedConversation: typeof conversation = [];
  let includedChars = 0;
  for (const message of [...conversation].reverse()) {
    if (boundedConversation.length && includedChars + message.content.length > maxConversationChars) break;
    if (!boundedConversation.length && message.content.length > maxConversationChars) {
      return NextResponse.json({ error: "Esta mensagem está grande demais para a Val. Envie uma versão mais curta." }, { status: 413 });
    }
    boundedConversation.unshift(message);
    includedChars += message.content.length;
  }
  const contextEstimate = Math.ceil((includedChars + workspaceInstructions.length + VAL_PERSONA.length + 3000) / 4);
  const needsTools = Object.keys(financialTools).length > 0 && (currentNeedsData || requestsAction);
  const requirements = { tools: needsTools, structuredOutput: taskType === "STRUCTURED_RESPONSE", contextTokens: contextEstimate + maxOutputTokens };
  const orderedCandidates = selectFreeModels(runtime.candidates, requirements)
    .map((candidate) => runtime.candidates.find((row) => row.provider === candidate.provider && row.modelId === candidate.modelId))
    .filter((candidate): candidate is RoutedModel => Boolean(candidate));
  const candidates: RoutedModel[] = [];
  for (const candidate of orderedCandidates) {
    if (candidate.requiresProbe) {
      const { data: claimed, error: claimError } = await admin.rpc("claim_val_ai_model_probe", { p_provider_id: candidate.provider, p_model_id: candidate.modelId });
      if (claimError || claimed !== true) continue;
      candidates.push({ ...candidate, requiresProbe: false });
    } else candidates.push(candidate);
    if (candidates.length >= Math.max(1, Math.min(3, maxAttempts))) break;
  }
  if (!candidates.length) {
    await recordValAiBlockedRequest({ requestId, userId: user.id, workspaceId: workspace.id, taskType, reason: "ALL_FREE_MODELS_UNAVAILABLE" });
    return unavailable();
  }
  if (override?.is_blocked) {
    await recordValAiBlockedRequest({ requestId, userId: user.id, workspaceId: workspace.id, taskType, reason: "USER_BLOCKED" });
    return NextResponse.json({ error: quotaMessage("USER_BLOCKED") }, { status: 403 });
  }

  const maxReservation = Math.max(1, requirements.contextTokens + maxOutputTokens) * Math.max(1, Math.min(3, maxAttempts));
  const { data: quota, error: quotaError } = await admin.rpc("reserve_val_ai_user_request", { p_user_id: user.id, p_request_id: requestId, p_reserved_tokens: maxReservation });
  if (quotaError) {
    console.error("Central Val AI user quota guard unavailable", JSON.stringify({ code: quotaError.code || "UNKNOWN" }));
    return unavailable();
  }
  if (!quota?.allowed) {
    await recordValAiBlockedRequest({ requestId, userId: user.id, workspaceId: workspace.id, taskType, reason: String(quota.reason || "USER_QUOTA_EXCEEDED") });
    const status = quota.reason === "USER_BLOCKED" ? 403 : quota.reason === "DUPLICATE_REQUEST" ? 409 : 429;
    const message = quota.reason === "DUPLICATE_REQUEST" ? "Esta consulta já foi recebida. Aguarde um momento antes de enviar novamente." : quotaMessage(String(quota.reason || "REQUEST_LIMIT"));
    return NextResponse.json({ error: message, usage: { dailyRemaining: quota.daily_remaining ?? null, monthlyRemaining: quota.monthly_remaining ?? null } }, { status });
  }

  const timeout = AbortSignal.timeout(27_000);
  const verifiedCatalogs = new Map<ValProvider, Awaited<ReturnType<typeof discoverFreeModelCatalog>>["models"]>();
  try {
    const result = await runFreeModelCandidates(candidates, requirements, maxAttempts, async (candidate, attempt) => {
      const attemptStartedAt = Date.now();
      try {
        let catalog = verifiedCatalogs.get(candidate.provider);
        if (!catalog) {
          const discovered = await discoverFreeModelCatalog(candidate.provider, candidate.apiKey, AbortSignal.timeout(8_000));
          catalog = discovered.models;
          verifiedCatalogs.set(candidate.provider, catalog);
          await admin.from("val_ai_providers").update({ quota_headers: discovered.quotaHeaders, updated_at: new Date().toISOString() }).eq("id", candidate.provider);
        }
        const currentEntry = catalog.find((entry) => entry.model_id === candidate.modelId);
        const decision = verifyCurrentFreeCatalogEntry(candidate.provider, candidate.modelId, catalog, candidate.freeTierConfirmed);
        if (decision !== "VERIFIED_FREE") {
          if (decision === "MODEL_NOT_IN_CATALOG" || decision === "MODEL_NOT_ZERO_PRICED") {
            await admin.from("val_ai_models").update({ is_free: false, free_verified: false, free_evidence: null, is_enabled: false, health_status: "UNAVAILABLE", official_prompt_price: currentEntry?.official_prompt_price ?? null, official_completion_price: currentEntry?.official_completion_price ?? null, catalog_seen_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("provider_id", candidate.provider).eq("model_id", candidate.modelId);
          }
          throw new AIProviderError({ provider: candidate.provider, model: candidate.modelId, category: "MODEL_UNAVAILABLE", providerCode: decision });
        }
        if (candidate.provider === "groq") {
          const { data: currentProvider } = await admin.from("val_ai_providers").select("enabled, free_tier_confirmed").eq("id", candidate.provider).maybeSingle();
          if (!currentProvider?.enabled || !currentProvider.free_tier_confirmed) throw new AIProviderError({ provider: candidate.provider, model: candidate.modelId, category: "MODEL_UNAVAILABLE", providerCode: "GROQ_FREE_TIER_CONFIRMATION_REVOKED" });
        }
        const { error: catalogUpdateError } = await admin.from("val_ai_models").update({
          catalog_seen_at: new Date().toISOString(),
          ...(candidate.provider === "openrouter" ? { official_prompt_price: currentEntry?.official_prompt_price, official_completion_price: currentEntry?.official_completion_price } : {}),
        }).eq("provider_id", candidate.provider).eq("model_id", candidate.modelId).eq("is_free", true).eq("free_verified", true).eq("is_enabled", true);
        if (catalogUpdateError) throw new AIProviderError({ provider: candidate.provider, model: candidate.modelId, category: "PROVIDER_UNAVAILABLE", providerCode: "FREE_MODEL_REVALIDATION_SAVE_FAILED" });
        const agent = new ToolLoopAgent({
          model: createValModel(candidate, needsTools),
          instructions: canUseFinancialContext
            ? actionsEnabled
          ? `${VAL_PERSONA}\n\n${workspaceInstructions}\n\nPERMISSÃO DE AÇÕES: Você pode somente preparar uma proposta de receita ou despesa comum quando o usuário pedir explicitamente para registrar. Use a ferramenta de proposta; ela não grava nada. Se faltar valor, tipo, data, conta ou categoria inequívocos, faça uma pergunta em vez de supor. Nunca diga que algo foi salvo: somente a pessoa pode confirmar ou descartar a proposta na interface. Não tente transferências, cartões/parcelas, investimentos, metas, edição ou exclusão.`
              : `${VAL_PERSONA}\n\n${workspaceInstructions}`
            : `${workspaceInstructions}\n\n${NO_FINANCIAL_CONTEXT_INSTRUCTION}`,
          tools: financialTools,
          stopWhen: isStepCount(4),
          toolChoice: needsTools ? "required" : "auto",
          maxOutputTokens,
          maxRetries: 0,
          temperature: 0.2,
          allowSystemInMessages: false,
        });
        const generated = await agent.generate({ messages: boundedConversation, timeout: 26_000, abortSignal: timeout });
        if (!generated.text.trim()) throw new AIProviderError({ provider: candidate.provider, model: candidate.modelId, category: generated.finishReason === "content-filter" ? "CONTENT_BLOCKED" : "MALFORMED_RESPONSE", providerCode: generated.finishReason });
        const latencyMs = Date.now() - attemptStartedAt;
        const quotaHeaders = readSafeQuotaHeaders(new Headers(generated.response.headers));
        await Promise.all([
          recordValAiAttempt({ requestId, userId: user.id, workspaceId: workspace.id, taskType, attempt, provider: candidate.provider, model: candidate.modelId, status: "SUCCESS", latencyMs, inputTokens: generated.usage.inputTokens, outputTokens: generated.usage.outputTokens, quotaHeaders }),
          recordValAiModelHealth({ provider: candidate.provider, model: candidate.modelId, ok: true, latencyMs, quotaHeaders }),
        ]);
        return { generated, candidate, latencyMs };
      } catch (error) {
        const failure = classifyAIError(error, candidate.provider, candidate.modelId);
        const latencyMs = Date.now() - attemptStartedAt;
        await Promise.all([
          recordValAiAttempt({ requestId, userId: user.id, workspaceId: workspace.id, taskType, attempt, provider: candidate.provider, model: candidate.modelId, status: "FAILED", latencyMs, errorCategory: failure.category, providerCode: failure.providerCode, httpStatus: failure.httpStatus, providerRequestId: failure.requestId }),
          recordValAiModelHealth({ provider: candidate.provider, model: candidate.modelId, ok: false, latencyMs, category: failure.category, providerCode: failure.providerCode }),
        ]);
        if (createdProposals.length) throw Object.assign(failure, { noFallback: true });
        throw failure;
      }
    });

    const { generated, candidate } = result.result;
    const reply = formatValResponse(createdProposals.length
      ? `Preparei uma proposta de ${createdProposals[0].action_type === "expense" ? "despesa" : "receita"}. Confira os dados e confirme ou descarte; nada será registrado sem sua aprovação.`
      : generated.text);
    if (!reply) throw new AIProviderError({ provider: candidate.provider, model: candidate.modelId, category: generated.finishReason === "content-filter" ? "CONTENT_BLOCKED" : "MALFORMED_RESPONSE", providerCode: generated.finishReason });
    const { error: saveError } = await admin.from("personal_ai_messages").insert([
      { user_id: user.id, workspace_id: workspace.id, role: "user", content: current.content },
      { user_id: user.id, workspace_id: workspace.id, role: "assistant", content: reply },
    ]);
    if (saveError) console.error("Val AI conversation persistence failed", JSON.stringify({ requestId, code: saveError.code || "UNKNOWN" }));
    return NextResponse.json({ reply, proposals: createdProposals, usage: { totalTokens: null, requestRemaining: quota.daily_remaining ?? null } });
  } catch (error) {
    if (createdProposals.length) {
      await admin.from("personal_ai_action_proposals").update({ status: "cancelled", acted_at: new Date().toISOString() })
        .eq("workspace_id", workspace.id).eq("user_id", user.id).eq("status", "pending").in("id", createdProposals.map((item) => item.id));
    }
    const attempts = error && typeof error === "object" && "valAttempts" in error && Array.isArray(error.valAttempts) ? error.valAttempts : [];
    const category = errorCategory(error);
    await recordValAiBlockedRequest({ requestId, userId: user.id, workspaceId: workspace.id, taskType, reason: category === "UNKNOWN_PROVIDER_ERROR" ? "ALL_FREE_MODELS_FAILED" : category });
    if (attempts.length === 0) console.error("Central Val AI request failed before a provider attempt", JSON.stringify({ requestId, category }));
    return unavailable();
  } finally {
    await admin.rpc("finalize_val_ai_user_request", { p_user_id: user.id, p_request_id: requestId });
  }
}
