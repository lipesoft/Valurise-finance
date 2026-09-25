import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { ToolLoopAgent, isStepCount, type ToolSet } from "ai";
import { z } from "zod";
import { createBusinessFinanceTools, createPersonalFinanceTools } from "@/lib/personal-ai/tools";
import { formatValResponse } from "@/lib/personal-ai/presentation";
import { createPersonalAiTransactionProposalTool, type PersonalAiTransactionDraft } from "@/lib/personal-ai/actions";
import { NO_FINANCIAL_CONTEXT_INSTRUCTION, requestsTransactionAction, requiresPersonalFinanceData, VAL_PERSONA } from "@/lib/personal-ai";
import { AIProviderError, classifyAIError, createProviderModel, logAIError, type AIProvider } from "@/lib/personal-ai/providers";
import { isAIProvider } from "@/lib/personal-ai/provider-config";
import { isGemini25FlashModel, isSupportedGeminiModel } from "@/lib/personal-ai/model-options";
import { decryptPersonalAiKey } from "@/lib/personal-ai-crypto";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getVerifiedWorkspaceContext } from "@/lib/workspaces/server";
import { createUserScopedSupabaseClient } from "@/lib/supabase/user-scoped";
import { legalVersions } from "@/lib/legal-content";
import { recordPersonalAIUsage } from "@/lib/personal-ai/usage";
import { BUSINESS_ASSUMPTION_KEYS, type BusinessAssumption } from "@/lib/business-finance";

export const maxDuration = 30;

const schema = z.object({
  messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().trim().min(1).max(2000) }).strict()).min(1).max(12),
}).strict();

function bearerToken(request: NextRequest) {
  return request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim() || "";
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

  // Only the newest user message is accepted from the browser. Assistant history is loaded from this user's RLS-protected records.
  const current = [...parsed.data.messages].reverse().find((item) => item.role === "user");
  if (!current) return NextResponse.json({ error: "Envie uma pergunta para a Val." }, { status: 400 });

  const admin = getSupabaseAdminClient();
  const rateKey = createHash("sha256").update(`personal-ai\0${user.id}\0${workspace.id}`).digest("hex");
  // consume_public_rate_limit validates p_max_attempts <= 50; passing 60 made every chat request fail.
  const { data: allowed, error: rateError } = await admin.rpc("consume_public_rate_limit", {
    p_key: rateKey, p_max_attempts: 40, p_window_seconds: 3600,
  });
  if (rateError) {
    console.error("Val AI rate-limit check failed", JSON.stringify({ code: rateError.code || "UNKNOWN" }));
    return NextResponse.json({ error: "Não foi possível validar o limite seguro do chat. Sua mensagem ainda não foi enviada ao provedor de IA; tente novamente em instantes." }, { status: 503 });
  }
  if (allowed !== true) return NextResponse.json({ error: "Você atingiu o limite de mensagens desta hora. Tente novamente mais tarde." }, { status: 429, headers: { "Retry-After": "3600" } });

  const [{ data: connection, error: connectionError }, { data: consent }] = await Promise.all([
    admin.from("personal_ai_connections").select("provider, encrypted_api_key, model, insights_enabled, actions_enabled, validated_at, validated_model").eq("workspace_id", workspace.id).maybeSingle(),
    admin.from("workspace_ai_consents").select("ai_data_sharing_version, accepted_at").eq("user_id", user.id).eq("workspace_id", workspace.id).maybeSingle(),
  ]);
  if (connectionError || !connection) return NextResponse.json({ error: "Conecte sua IA pessoal nas Configurações antes de conversar." }, { status: 409 });
  if (!connection.validated_at || connection.validated_model !== connection.model) {
    return NextResponse.json({ error: "Sua configuração está salva, mas ainda não foi validada. Teste a conexão em Configurações antes de conversar." }, { status: 409, headers: { "Cache-Control": "no-store" } });
  }

  if (!isAIProvider(connection.provider)) return NextResponse.json({ error: "O provedor de IA conectado não é suportado." }, { status: 422 });
  const provider: AIProvider = connection.provider;
  if (provider === "gemini" && !isSupportedGeminiModel(connection.model)) {
    return NextResponse.json({ error: "O modelo Gemini salvo não está habilitado no Valurise. Em Configurações, selecione gemini-2.5-flash-lite ou gemini-2.5-flash e teste a conexão.", category: "INVALID_MODEL", providerCode: "MODEL_NOT_ALLOWED", model: connection.model }, { status: 409 });
  }
  const canUseFinancialContext = Boolean(connection.insights_enabled
    && consent?.ai_data_sharing_version === legalVersions.aiSharing
    && consent.accepted_at);
  const startedAt = Date.now();
  const timeout = AbortSignal.timeout(28_000);
  const workspaceInstructions = canUseFinancialContext
    ? workspace.type === "business"
      ? `CONTEXTO ATIVO: workspace empresarial “${workspace.displayName}”. Responda apenas sobre os dados deste workspace empresarial. Diferencie receitas e despesas registradas (realizadas) de valores informados, estimados e projetados; preserve a natureza e a origem devolvidas pelas ferramentas. Diga “dados insuficientes” quando algum componente estiver ausente; ausência não significa R$ 0. Use “resultado gerencial estimado/misto”, nunca “lucro” contábil ou fiscal se a base incluir estimativas. As contas a receber/pagar e as projeções são referências gerenciais, não títulos ou compromissos itemizados. Nunca misture ou suponha dados pessoais do titular.`
      : `CONTEXTO ATIVO: workspace pessoal “${workspace.displayName}”. Responda somente sobre as finanças pessoais presentes neste workspace.`
    : `MODO ATIVO: ${workspace.type === "business" ? "empresarial" : "pessoal"}. Não há consentimento para consultar dados financeiros deste workspace.`;
  let createdProposals: Array<{
    id: string; action_type: "income" | "expense"; amount_cents: number;
    category: string; account_label: string; description: string;
    transaction_date: string; expires_at: string;
  }> = [];

  try {
    const apiKey = decryptPersonalAiKey(connection.encrypted_api_key);
    const scoped = createUserScopedSupabaseClient(token);
    const priorMessages = canUseFinancialContext
      ? await scoped.from("personal_ai_messages").select("role, content").eq("workspace_id", workspace.id).eq("user_id", user.id).order("created_at", { ascending: false }).limit(10)
      : { data: [], error: null };
    if (priorMessages.error) return NextResponse.json({ error: "Não foi possível carregar o histórico autorizado da conversa." }, { status: 503 });

    let financialTools: ToolSet = {};
    if (canUseFinancialContext) {
      const { data: financial, error: financialError } = await scoped.from("user_financial_state").select("state, version").eq("workspace_id", workspace.id).maybeSingle();
      if (financialError) return NextResponse.json({ error: "Não foi possível consultar os dados financeiros com segurança." }, { status: 503 });
      const state = financial?.state || {};
      const readTools = createPersonalFinanceTools(state);
      const businessTools = workspace.type === "business" ? createBusinessFinanceTools(state, async (period) => {
        const referenceMonth = `${period}-01`;
        const results = await Promise.all(BUSINESS_ASSUMPTION_KEYS.map((metricKey) => scoped
          .from("business_financial_assumptions")
          .select("metric_key, amount_cents, nature, source, reference_month, is_cleared, created_at")
          .eq("workspace_id", workspace.id)
          .eq("metric_key", metricKey)
          .lte("reference_month", referenceMonth)
          .order("reference_month", { ascending: false })
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle()));
        const failed = results.find((result) => result.error);
        if (failed) throw new Error("Business financial context is unavailable.");
        return results.flatMap((result) => {
          const row = result.data;
          if (!row || row.is_cleared || !Number.isSafeInteger(Number(row.amount_cents))) return [];
          return [{
            metricKey: row.metric_key,
            amountCents: Number(row.amount_cents),
            nature: row.nature,
            source: row.source,
            referenceMonth: row.reference_month,
            createdAt: row.created_at,
          } as BusinessAssumption];
        });
      }) : {};
      if (connection.actions_enabled && financial && Number.isInteger(financial.version)) {
        let proposalCreated = false;
        const proposalTool = createPersonalAiTransactionProposalTool(state, async (draft: PersonalAiTransactionDraft) => {
          if (proposalCreated) throw new Error("Preparei uma proposta por vez para você revisar.");
          const { count, error: countError } = await admin.from("personal_ai_action_proposals")
            .select("id", { count: "exact", head: true }).eq("workspace_id", workspace.id).eq("user_id", user.id).eq("status", "pending")
            .gt("expires_at", new Date().toISOString());
          if (countError) throw new Error("Não foi possível verificar propostas pendentes.");
          if ((count || 0) >= 5) throw new Error("Você já tem várias propostas aguardando revisão. Confirme ou descarte uma antes de pedir outra.");
          const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
          const { data: proposal, error: insertError } = await admin.from("personal_ai_action_proposals").insert({
            user_id: user.id,
            workspace_id: workspace.id,
            consent_version: legalVersions.aiSharing,
            action_type: draft.type,
            amount_cents: draft.amountCents,
            category: draft.category,
            account_label: draft.account,
            description: draft.description,
            transaction_date: draft.date,
            expected_state_version: financial.version,
            expires_at: expiresAt,
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

    const history = [...(priorMessages.data || [])].reverse().map((item) => ({
      role: item.role as "user" | "assistant",
      content: item.content,
    }));
    // If the browser retried after an uncertain network result, do not send its duplicated last message twice.
    const lastSaved = history.at(-1);
    const conversation = lastSaved?.role === "user" && lastSaved.content === current.content
      ? history
      : [...history, { role: "user" as const, content: current.content }];

    const agent = new ToolLoopAgent({
      model: createProviderModel(provider, apiKey, connection.model),
      instructions: canUseFinancialContext
        ? connection.actions_enabled
          ? `${VAL_PERSONA}\n\n${workspaceInstructions}\n\nPERMISSÃO DE AÇÕES: Você pode somente preparar uma proposta de receita ou despesa comum quando o usuário pedir explicitamente para registrar. Use a ferramenta de proposta; ela não grava nada. Se faltar valor, tipo, data, conta ou categoria inequívocos, faça uma pergunta em vez de supor. Nunca diga que algo foi salvo: somente a pessoa pode confirmar ou descartar a proposta na interface. Não tente transferências, cartões/parcelas, investimentos, metas, edição ou exclusão.`
          : `${VAL_PERSONA}\n\n${workspaceInstructions}`
        : `${workspaceInstructions}\n\n${NO_FINANCIAL_CONTEXT_INSTRUCTION}`,
      tools: financialTools,
      stopWhen: isStepCount(4),
      toolChoice: canUseFinancialContext && requiresPersonalFinanceData(conversation)
        && !(connection.actions_enabled && requestsTransactionAction(current.content)) ? "required" : "auto",
      maxOutputTokens: 700,
      maxRetries: 0,
      ...(provider !== "gemini" ? { temperature: 0.2 } : {}),
      ...(provider === "gemini" && isGemini25FlashModel(connection.model)
        ? { providerOptions: { google: { thinkingConfig: { thinkingBudget: 0 } } } }
        : {}),
      allowSystemInMessages: false,
    });
    const result = await agent.generate({ messages: conversation, timeout: 27_000, abortSignal: timeout });
    const reply = formatValResponse(createdProposals.length
      ? `Preparei uma proposta de ${createdProposals[0].action_type === "expense" ? "despesa" : "receita"}. Confira os dados e confirme ou descarte; nada será registrado sem sua aprovação.`
      : result.text);
    if (!reply) {
      const failure = new AIProviderError({ provider, model: connection.model, category: result.finishReason === "content-filter" ? "CONTENT_BLOCKED" : "MALFORMED_RESPONSE", providerCode: result.finishReason });
      logAIError(failure, Date.now() - startedAt);
      await recordPersonalAIUsage({ userId: user.id, workspaceId: workspace.id, provider, model: connection.model, latencyMs: Date.now() - startedAt, kind: "chat", error: failure });
      return NextResponse.json({ error: failure.message, category: failure.category }, { status: 502 });
    }

    const { error: saveError } = await admin.from("personal_ai_messages").insert([
      { user_id: user.id, workspace_id: workspace.id, role: "user", content: current.content },
      { user_id: user.id, workspace_id: workspace.id, role: "assistant", content: reply },
    ]);
    if (saveError) console.error("Val AI conversation persistence failed", JSON.stringify({ provider, model: connection.model, code: saveError.code }));

    const inputTokens = result.usage.inputTokens ?? undefined;
    const outputTokens = result.usage.outputTokens ?? undefined;
    await recordPersonalAIUsage({ userId: user.id, workspaceId: workspace.id, provider, model: connection.model, inputTokens, outputTokens, latencyMs: Date.now() - startedAt, kind: "chat" });
    return NextResponse.json({ reply, proposals: createdProposals, usage: { inputTokens: inputTokens ?? null, outputTokens: outputTokens ?? null, totalTokens: inputTokens === undefined && outputTokens === undefined ? null : (inputTokens || 0) + (outputTokens || 0) } });
  } catch (error) {
    if (createdProposals.length) {
      await getSupabaseAdminClient().from("personal_ai_action_proposals")
        .update({ status: "cancelled", acted_at: new Date().toISOString() })
        .eq("workspace_id", workspace.id).eq("user_id", user.id).eq("status", "pending").in("id", createdProposals.map((item) => item.id));
    }
    const failure = classifyAIError(error, provider, connection.model);
    logAIError(failure, Date.now() - startedAt);
    await recordPersonalAIUsage({ userId: user.id, workspaceId: workspace.id, provider, model: connection.model, latencyMs: Date.now() - startedAt, kind: "chat", error: failure });
    return NextResponse.json({ error: failure.message, category: failure.category, providerMessage: failure.providerMessage, providerCode: failure.providerCode, providerHttpStatus: failure.httpStatus, requestId: failure.requestId, retryable: failure.retryable, model: connection.model }, { status: 502 });
  }
}
