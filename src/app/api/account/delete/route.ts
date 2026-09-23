import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSupabaseAdminClient, getVerifiedActiveUser } from "@/lib/supabase/admin";

const schema = z.object({ password: z.string().min(1).max(200), confirmation: z.literal("EXCLUIR") });

export async function POST(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (origin && new URL(origin).origin !== request.nextUrl.origin) {
    return NextResponse.json({ error: "Solicitação inválida." }, { status: 403 });
  }
  const user = await getVerifiedActiveUser(request.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Não autorizado." }, { status: 401 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Confirme a senha e digite EXCLUIR." }, { status: 400 });

  const admin = getSupabaseAdminClient();
  const bucket = createHash("sha256").update(`account-delete\0${user.id}`).digest("hex");
  const { data: allowed, error: limitError } = await admin.rpc("consume_public_rate_limit", {
    p_key: bucket,
    p_max_attempts: 3,
    p_window_seconds: 3600,
  });
  if (limitError) return NextResponse.json({ error: "A exclusão está temporariamente indisponível." }, { status: 503 });
  if (allowed !== true) return NextResponse.json({ error: "Muitas tentativas. Aguarde uma hora." }, { status: 429, headers: { "Retry-After": "3600" } });

  const { data: account, error: accountError } = await admin.auth.admin.getUserById(user.id);
  if (accountError || !account.user?.email) return NextResponse.json({ error: "Não foi possível confirmar sua conta." }, { status: 400 });
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !publishableKey) return NextResponse.json({ error: "Autenticação indisponível." }, { status: 503 });
  const verifier = createClient(url, publishableKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { error: passwordError } = await verifier.auth.signInWithPassword({ email: account.user.email, password: parsed.data.password });
  if (passwordError) return NextResponse.json({ error: "Senha incorreta. A conta não foi alterada." }, { status: 401 });

  const trashedAt = new Date().toISOString();
  const { data: profile, error: profileError } = await admin.from("profiles")
    .update({ account_status: "trashed", trashed_at: trashedAt, disabled_at: null })
    .eq("id", user.id).select("id").maybeSingle();
  if (profileError || !profile) return NextResponse.json({ error: "Não foi possível mover a conta para a lixeira." }, { status: 500 });

  const { error: banError } = await admin.auth.admin.updateUserById(user.id, { ban_duration: "876000h" });
  if (banError) {
    await admin.from("profiles").update({ account_status: "active", trashed_at: null }).eq("id", user.id);
    return NextResponse.json({ error: "Não foi possível suspender o acesso. A conta não foi alterada." }, { status: 500 });
  }

  const { error: auditError } = await admin.from("master_audit_log").insert({
    actor_id: user.id,
    target_user_id: user.id,
    action: "trashed",
  });
  if (auditError) {
    console.error("Falha ao registrar solicitação de exclusão na auditoria.");
    await admin.from("profiles").update({ account_status: "active", trashed_at: null }).eq("id", user.id);
    await admin.auth.admin.updateUserById(user.id, { ban_duration: "none" });
    return NextResponse.json({ error: "Não foi possível registrar a solicitação. A conta foi mantida ativa." }, { status: 500 });
  }
  return NextResponse.json({ ok: true, status: "trashed" });
}
