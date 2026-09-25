import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { encryptPersonalAiKey } from "@/lib/personal-ai-crypto";
import { getSupabaseAdminClient, getVerifiedActiveUser } from "@/lib/supabase/admin";
import { legalVersions } from "@/lib/legal-content";

const connectionSchema = z.object({
  provider: z.enum(["openai", "gemini", "deepseek"]),
  apiKey: z.string().trim().min(12).max(512).optional(),
  model: z.string().trim().min(2).max(100).regex(/^[a-zA-Z0-9._:-]+$/),
  insightsEnabled: z.boolean().default(false),
  notificationsEnabled: z.boolean().default(false),
  actionsEnabled: z.boolean().optional(),
});

async function userFrom(request: NextRequest) {
  return getVerifiedActiveUser(request.headers.get("authorization"));
}

export async function GET(request: NextRequest) {
  const user = await userFrom(request);
  if (!user) return NextResponse.json({ error: "Não autorizado." }, { status: 401 });
  const admin = getSupabaseAdminClient();
  const [{ data, error }, { data: consent }] = await Promise.all([
    admin
    .from("personal_ai_connections")
    .select("provider, model, insights_enabled, notifications_enabled, actions_enabled, connected_at, updated_at, validated_at, validated_model")
    .eq("user_id", user.id)
    .maybeSingle(),
    admin.from("user_consents").select("ai_data_sharing_version, ai_data_sharing_accepted_at")
      .eq("user_id", user.id).maybeSingle(),
  ]);
  if (error) return NextResponse.json({ error: "Não foi possível consultar a conexão." }, { status: 500 });
  const canUseFinancialContext = consent?.ai_data_sharing_version === legalVersions.aiSharing && Boolean(consent.ai_data_sharing_accepted_at);
  const consentRenewalRequired = Boolean(data?.insights_enabled && consent?.ai_data_sharing_accepted_at && consent.ai_data_sharing_version !== legalVersions.aiSharing);
  return NextResponse.json({ connection: data ? {
    ...data,
    insights_enabled: Boolean(data.insights_enabled && canUseFinancialContext),
    actions_enabled: Boolean(data.actions_enabled && data.insights_enabled && canUseFinancialContext),
    consentRenewalRequired,
    validated: Boolean(data.validated_at && data.validated_model === data.model),
  } : null });
}

export async function POST(request: NextRequest) {
  const user = await userFrom(request);
  if (!user) return NextResponse.json({ error: "Não autorizado." }, { status: 401 });
  const parsed = connectionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Dados da conexão inválidos." }, { status: 400 });
  if (parsed.data.actionsEnabled && !parsed.data.insightsEnabled) {
    return NextResponse.json({ error: "Para permitir propostas financeiras, habilite primeiro o consentimento de contexto financeiro." }, { status: 400 });
  }

  try {
    const value = parsed.data;
    const admin = getSupabaseAdminClient();
    const { data: existing, error: existingError } = await admin.from("personal_ai_connections")
      .select("provider, model, encrypted_api_key, actions_enabled, validated_at, validated_model").eq("user_id", user.id).maybeSingle();
    if (existingError) return NextResponse.json({ error: "Não foi possível consultar a conexão atual." }, { status: 500 });
    if (!value.apiKey && (!existing || existing.provider !== value.provider)) {
      return NextResponse.json({ error: "Informe a API key para conectar este provedor." }, { status: 400 });
    }
    const sameSavedModel = Boolean(existing && existing.provider === value.provider && existing.model === value.model && !value.apiKey);
    const actionsEnabled = value.insightsEnabled && (value.actionsEnabled ?? Boolean(existing?.actions_enabled));
    let pendingProposalsCancelled = false;
    if (actionsEnabled) {
      const { data: cancelled, error: cancelError } = await admin.from("personal_ai_action_proposals")
        .update({ status: "cancelled", acted_at: new Date().toISOString() })
        .eq("user_id", user.id).eq("status", "pending").select("id");
      if (cancelError) return NextResponse.json({ error: "Não foi possível encerrar as propostas antigas. A permissão não foi alterada." }, { status: 503 });
      pendingProposalsCancelled = Boolean(cancelled?.length);
    }
    const acceptedAt = new Date().toISOString();
    const { error } = await admin.from("personal_ai_connections").upsert({
      user_id: user.id,
      provider: value.provider,
      encrypted_api_key: value.apiKey ? encryptPersonalAiKey(value.apiKey) : existing!.encrypted_api_key,
      model: value.model,
      insights_enabled: value.insightsEnabled,
      notifications_enabled: value.insightsEnabled && value.notificationsEnabled,
      actions_enabled: actionsEnabled,
      validated_at: sameSavedModel ? existing!.validated_at : null,
      validated_model: sameSavedModel ? existing!.validated_model : null,
      connected_at: acceptedAt,
      updated_at: acceptedAt,
    }, { onConflict: "user_id" });
    if (error) return NextResponse.json({ error: "Não foi possível salvar a conexão." }, { status: 500 });
    const { error: consentError } = await admin.from("user_consents").upsert({
      user_id: user.id,
      ai_data_sharing_accepted_at: value.insightsEnabled ? acceptedAt : null,
      ai_data_sharing_revoked_at: value.insightsEnabled ? null : acceptedAt,
      ai_data_sharing_version: value.insightsEnabled ? legalVersions.aiSharing : null,
      updated_at: acceptedAt,
    }, { onConflict: "user_id" });
    if (consentError) return NextResponse.json({ error: "A conexão foi salva, mas não foi possível registrar sua preferência de privacidade. Revise o consentimento em Configurações." }, { status: 500 });
    if (!actionsEnabled) {
      const { data: cancelled, error: cancelError } = await admin.from("personal_ai_action_proposals").update({ status: "cancelled", acted_at: acceptedAt })
        .eq("user_id", user.id).eq("status", "pending").select("id");
      if (cancelError) return NextResponse.json({ error: "A permissão foi desligada, mas não foi possível encerrar propostas antigas. Elas não podem ser confirmadas; tente salvar novamente." }, { status: 503 });
      pendingProposalsCancelled = Boolean(cancelled?.length);
    }
    const validated = Boolean(sameSavedModel && existing?.validated_at && existing.validated_model === value.model);
    return NextResponse.json({ ok: true, pendingProposalsCancelled, validated, validatedAt: validated ? existing?.validated_at : null });
  } catch {
    return NextResponse.json({ error: "Não foi possível proteger a chave da IA." }, { status: 503 });
  }
}

export async function DELETE(request: NextRequest) {
  const user = await userFrom(request);
  if (!user) return NextResponse.json({ error: "Não autorizado." }, { status: 401 });
  const admin = getSupabaseAdminClient();
  const { error } = await admin.from("personal_ai_connections").delete().eq("user_id", user.id);
  if (error) return NextResponse.json({ error: "Não foi possível remover a conexão." }, { status: 500 });
  const revokedAt = new Date().toISOString();
  await admin.from("personal_ai_action_proposals").update({ status: "cancelled", acted_at: revokedAt })
    .eq("user_id", user.id).eq("status", "pending");
  const { error: consentError } = await admin.from("user_consents").update({
    ai_data_sharing_version: null,
    ai_data_sharing_accepted_at: null,
    ai_data_sharing_revoked_at: revokedAt,
    updated_at: revokedAt,
  }).eq("user_id", user.id);
  if (consentError) return NextResponse.json({ error: "A chave foi removida, mas não foi possível atualizar o registro de consentimento. Revise as Configurações de privacidade." }, { status: 500 });
  return NextResponse.json({ ok: true });
}
