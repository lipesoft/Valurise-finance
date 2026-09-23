import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { encryptPersonalAiKey } from "@/lib/personal-ai-crypto";
import { getSupabaseAdminClient, getVerifiedActiveUser } from "@/lib/supabase/admin";
import { legalVersions } from "@/lib/legal-content";

const connectionSchema = z.object({
  provider: z.enum(["openai", "gemini", "deepseek"]),
  apiKey: z.string().trim().min(12).max(512).optional(),
  model: z.string().trim().min(2).max(100).regex(/^[a-zA-Z0-9._:-]+$/),
  insightsEnabled: z.boolean().default(true),
  notificationsEnabled: z.boolean().default(false),
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
    .select("provider, model, insights_enabled, notifications_enabled, connected_at, updated_at")
    .eq("user_id", user.id)
    .maybeSingle(),
    admin.from("user_consents").select("ai_data_sharing_version, ai_data_sharing_accepted_at")
      .eq("user_id", user.id).maybeSingle(),
  ]);
  if (error) return NextResponse.json({ error: "Não foi possível consultar a conexão." }, { status: 500 });
  const canUseFinancialContext = consent?.ai_data_sharing_version === legalVersions.aiSharing && Boolean(consent.ai_data_sharing_accepted_at);
  return NextResponse.json({ connection: data ? { ...data, insights_enabled: Boolean(data.insights_enabled && canUseFinancialContext) } : null });
}

export async function POST(request: NextRequest) {
  const user = await userFrom(request);
  if (!user) return NextResponse.json({ error: "Não autorizado." }, { status: 401 });
  const parsed = connectionSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: "Dados da conexão inválidos." }, { status: 400 });

  try {
    const value = parsed.data;
    const admin = getSupabaseAdminClient();
    const { data: existing, error: existingError } = await admin.from("personal_ai_connections")
      .select("provider, encrypted_api_key").eq("user_id", user.id).maybeSingle();
    if (existingError) return NextResponse.json({ error: "Não foi possível consultar a conexão atual." }, { status: 500 });
    if (!value.apiKey && (!existing || existing.provider !== value.provider)) {
      return NextResponse.json({ error: "Informe a API key para conectar este provedor." }, { status: 400 });
    }
    const acceptedAt = new Date().toISOString();
    const { error: consentError } = await admin.from("user_consents").upsert({
      user_id: user.id,
      ai_data_sharing_accepted_at: value.insightsEnabled ? acceptedAt : null,
      ai_data_sharing_revoked_at: value.insightsEnabled ? null : acceptedAt,
      ai_data_sharing_version: value.insightsEnabled ? legalVersions.aiSharing : null,
      updated_at: acceptedAt,
    }, { onConflict: "user_id" });
    if (consentError) return NextResponse.json({ error: "Não foi possível registrar sua preferência de privacidade." }, { status: 500 });
    const { error } = await admin.from("personal_ai_connections").upsert({
      user_id: user.id,
      provider: value.provider,
      encrypted_api_key: value.apiKey ? encryptPersonalAiKey(value.apiKey) : existing!.encrypted_api_key,
      model: value.model,
      insights_enabled: value.insightsEnabled,
      notifications_enabled: value.insightsEnabled && value.notificationsEnabled,
      connected_at: acceptedAt,
      updated_at: acceptedAt,
    }, { onConflict: "user_id" });
    if (error) return NextResponse.json({ error: "Não foi possível salvar a conexão." }, { status: 500 });
    return NextResponse.json({ ok: true });
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
  return NextResponse.json({ ok: true });
}
