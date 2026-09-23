import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createHash } from "node:crypto";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { normalizeUsername } from "@/lib/auth/username";
import { legalVersions } from "@/lib/legal-content";

const requestSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  username: z.string(),
  email: z.string().trim().email().max(254),
  password: z.string().min(8).max(200),
  privacyAccepted: z.literal(true),
  termsAccepted: z.literal(true),
  inviteToken: z.string().uuid().optional(),
});

const genericAccepted = () => NextResponse.json({ ok: true }, { status: 202 });
const bucket = (scope: string, value: string) => createHash("sha256").update(`${scope}\0${value}`).digest("hex");

async function consumeLimit(admin: ReturnType<typeof getSupabaseAdminClient>, key: string, attempts: number) {
  return admin.rpc("consume_public_rate_limit", {
    p_key: key,
    p_max_attempts: attempts,
    p_window_seconds: 3600,
  });
}

/**
 * Public registration creates a real Supabase Auth user, already banned, and
 * a database-owned pending profile. The password goes straight to Supabase
 * Auth and is never stored by Valurise. Only a Master approval can unban it.
 */
export async function POST(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (origin && new URL(origin).origin !== request.nextUrl.origin) {
    return NextResponse.json({ error: "Solicitação inválida." }, { status: 403 });
  }
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > 16_000) return NextResponse.json({ error: "Solicitação inválida." }, { status: 413 });

  const admin = getSupabaseAdminClient();
  const forwardedFor = request.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim();
  const clientAddress = forwardedFor || request.headers.get("x-real-ip") || "unknown";
  const addressLimit = await consumeLimit(admin, bucket("access-request:ip", clientAddress), 10);
  if (addressLimit.error) return NextResponse.json({ error: "Cadastro temporariamente indisponível. Tente novamente mais tarde." }, { status: 503 });
  if (addressLimit.data !== true) return NextResponse.json({ error: "Muitas tentativas. Aguarde um pouco e tente novamente." }, { status: 429, headers: { "Retry-After": "3600" } });

  const rawBody = await request.text().catch(() => "");
  if (rawBody.length > 16_000) return NextResponse.json({ error: "Solicitação inválida." }, { status: 413 });
  const body = (() => { try { return JSON.parse(rawBody); } catch { return null; } })();
  const parsed = requestSchema.safeParse(body && {
    ...body,
    username: normalizeUsername(typeof body.username === "string" ? body.username : ""),
  });
  if (!parsed.success) {
    return NextResponse.json({ error: "Confira nome, e-mail, usuário e senha (mínimo de 8 caracteres)." }, { status: 400 });
  }

  const { fullName, username, email, password } = parsed.data;
  if (parsed.data.inviteToken) {
    const { data: invite, error: inviteError } = await admin.from("access_invites")
      .select("id").eq("token", parsed.data.inviteToken).is("used_by", null)
      .gt("expires_at", new Date().toISOString()).maybeSingle();
    if (inviteError) return NextResponse.json({ error: "Não foi possível validar o convite agora." }, { status: 503 });
    if (!invite) return NextResponse.json({ error: "Este convite é inválido, expirou ou já foi utilizado." }, { status: 400 });
  }
  const emailLimit = await consumeLimit(admin, bucket("access-request:email", email.toLowerCase()), 4);
  if (emailLimit.error) return NextResponse.json({ error: "Cadastro temporariamente indisponível. Tente novamente mais tarde." }, { status: 503 });
  if (emailLimit.data !== true) return NextResponse.json({ error: "Muitas tentativas. Aguarde um pouco e tente novamente." }, { status: 429, headers: { "Retry-After": "3600" } });

  if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
    return NextResponse.json({ error: "Escolha um usuário com pelo menos 3 caracteres." }, { status: 400 });
  }
  const { data: existingUsername } = await admin
    .from("profiles")
    .select("id")
    .eq("username", username)
    .maybeSingle();
  // Use the same response for an occupied username/email and a newly recorded
  // request so this endpoint cannot be used to enumerate registered accounts.
  if (existingUsername) return genericAccepted();

  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    ban_duration: "876000h",
    user_metadata: { full_name: fullName, username },
  });
  if (createError || !created.user) {
    if (createError?.message.toLowerCase().includes("already") || createError?.code === "email_exists") return genericAccepted();
    return NextResponse.json({ error: "Não foi possível processar o cadastro agora. Tente novamente mais tarde." }, { status: 503 });
  }

  // The auth trigger normally writes this row. Upsert makes the request
  // durable even if the trigger was temporarily unavailable during setup.
  const { error: profileError } = await admin.from("profiles").upsert({
    id: created.user.id,
    full_name: fullName,
    username,
    account_status: "pending",
    account_role: "user",
  }, { onConflict: "id", ignoreDuplicates: true });
  if (profileError) {
    // Compensate for the Auth record if persistence of the approval request
    // fails. Leaving a usable-looking Auth user without a profile was the
    // source of requests that could not reach the Master queue.
    await admin.auth.admin.deleteUser(created.user.id);
    return NextResponse.json({ error: "Cadastro criado, mas a solicitação não pôde ser registrada. Tente novamente." }, { status: 500 });
  }

  const acceptedAt = new Date().toISOString();
  const { error: consentError } = await admin.from("user_consents").upsert({
    user_id: created.user.id,
    privacy_accepted_at: acceptedAt,
    privacy_version: legalVersions.privacy,
    terms_accepted_at: acceptedAt,
    terms_version: legalVersions.terms,
  }, { onConflict: "user_id" });
  if (consentError) {
    await admin.auth.admin.deleteUser(created.user.id);
    return NextResponse.json({ error: "Não foi possível registrar os consentimentos. Tente novamente." }, { status: 500 });
  }

  if (parsed.data.inviteToken) {
    const { data: claimed, error: claimError } = await admin.from("access_invites")
      .update({ used_by: created.user.id, used_at: acceptedAt })
      .eq("token", parsed.data.inviteToken).is("used_by", null)
      .gt("expires_at", acceptedAt).select("id").maybeSingle();
    if (claimError || !claimed) {
      await admin.auth.admin.deleteUser(created.user.id);
      return NextResponse.json({ error: "Este convite acabou de expirar ou já foi utilizado. Solicite um novo link." }, { status: 409 });
    }
  }

  return genericAccepted();
}
