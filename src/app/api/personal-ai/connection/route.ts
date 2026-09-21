import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { encryptPersonalAiKey } from "@/lib/personal-ai-crypto";
import { getSupabaseAdminClient, getVerifiedActiveUser } from "@/lib/supabase/admin";

const connectionSchema = z.object({
  provider: z.enum(["openai", "gemini"]),
  apiKey: z.string().trim().min(12).max(512),
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
  const { data, error } = await admin
    .from("personal_ai_connections")
    .select("provider, model, insights_enabled, notifications_enabled, connected_at, updated_at")
    .eq("user_id", user.id)
    .maybeSingle();
  if (error) return NextResponse.json({ error: "Não foi possível consultar a conexão." }, { status: 500 });
  return NextResponse.json({ connection: data || null });
}

export async function POST(request: NextRequest) {
  const user = await userFrom(request);
  if (!user) return NextResponse.json({ error: "Não autorizado." }, { status: 401 });
  const parsed = connectionSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: "Dados da conexão inválidos." }, { status: 400 });

  try {
    const value = parsed.data;
    const admin = getSupabaseAdminClient();
    const { error } = await admin.from("personal_ai_connections").upsert({
      user_id: user.id,
      provider: value.provider,
      encrypted_api_key: encryptPersonalAiKey(value.apiKey),
      model: value.model,
      insights_enabled: value.insightsEnabled,
      notifications_enabled: value.notificationsEnabled,
      connected_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
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
