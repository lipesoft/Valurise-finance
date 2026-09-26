import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
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

const responseError = (message: string, status: number) => NextResponse.json({ error: message }, { status });

/**
 * Starts a Supabase Auth email-confirmation flow. The Master queue is populated
 * only after Supabase changes email_confirmed_at; no password or API secret is
 * persisted by Valurise.
 */
export async function POST(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (origin) {
    try {
      if (new URL(origin).origin !== request.nextUrl.origin) return responseError("Solicitação inválida.", 403);
    } catch {
      return responseError("Solicitação inválida.", 403);
    }
  }
  if (Number(request.headers.get("content-length") || 0) > 16_000) return responseError("Solicitação inválida.", 413);

  const rawBody = await request.text().catch(() => "");
  if (rawBody.length > 16_000) return responseError("Solicitação inválida.", 413);
  const body = (() => { try { return JSON.parse(rawBody); } catch { return null; } })();
  const parsed = requestSchema.safeParse(body && {
    ...body,
    username: normalizeUsername(typeof body.username === "string" ? body.username : ""),
  });
  if (!parsed.success) return responseError("Confira nome, e-mail, usuário e senha (mínimo de 8 caracteres).", 400);

  const { fullName, username, password } = parsed.data;
  const email = parsed.data.email.trim().toLowerCase();
  const admin = getSupabaseAdminClient();
  const forwardedFor = request.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim();
  const clientAddress = forwardedFor || request.headers.get("x-real-ip") || "unknown";
  const addressLimit = await consumeLimit(admin, bucket("access-request:ip", clientAddress), 10);
  if (addressLimit.error) return responseError("Cadastro temporariamente indisponível. Tente novamente mais tarde.", 503);
  if (addressLimit.data !== true) return NextResponse.json({ error: "Muitas tentativas. Aguarde um pouco e tente novamente." }, { status: 429, headers: { "Retry-After": "3600" } });

  if (!/^[a-z0-9._-]{3,32}$/.test(username)) return responseError("Escolha um usuário com pelo menos 3 caracteres.", 400);
  const { data: existingUsername, error: usernameError } = await admin
    .from("profiles")
    .select("id")
    .eq("username", username)
    .maybeSingle();
  if (usernameError) return responseError("Cadastro temporariamente indisponível. Tente novamente mais tarde.", 503);
  if (existingUsername) return genericAccepted();

  const emailLimit = await consumeLimit(admin, bucket("access-request:email", email), 4);
  if (emailLimit.error) return responseError("Cadastro temporariamente indisponível. Tente novamente mais tarde.", 503);
  if (emailLimit.data !== true) return NextResponse.json({ error: "Muitas tentativas. Aguarde um pouco e tente novamente." }, { status: 429, headers: { "Retry-After": "3600" } });

  let inviteId: string | null = null;
  if (parsed.data.inviteToken) {
    const { data: invite, error: inviteError } = await admin.from("access_invites")
      .select("id")
      .eq("token", parsed.data.inviteToken)
      .is("used_by", null)
      .is("revoked_at", null)
      .gt("expires_at", new Date().toISOString())
      .maybeSingle();
    if (inviteError) return responseError("Não foi possível validar o convite agora.", 503);
    if (!invite) return responseError("Este convite é inválido, expirou ou já foi utilizado.", 400);
    inviteId = invite.id;
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !publishableKey) return responseError("Cadastro temporariamente indisponível.", 503);
  const auth = createClient(url, publishableKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
  const { data: signup, error: signupError } = await auth.auth.signUp({
    email,
    password,
    options: {
      emailRedirectTo: request.nextUrl.origin,
      data: { full_name: fullName, username },
    },
  });

  if (signupError) {
    if (signupError.code === "user_already_exists" || signupError.message.toLowerCase().includes("already registered")) return genericAccepted();
    return responseError("Não foi possível iniciar a confirmação por e-mail. Tente novamente mais tarde.", 503);
  }
  const newUser = signup.user;
  if (!newUser?.id || (Array.isArray(newUser.identities) && newUser.identities.length === 0)) return genericAccepted();

  // A session or an already-confirmed address means Auth confirmations are not
  // enforced. Roll back this just-created account rather than queueing an
  // address that was never proven to belong to the applicant.
  if (signup.session || newUser.email_confirmed_at) {
    const deleted = await admin.auth.admin.deleteUser(newUser.id);
    if (deleted.error) await admin.auth.admin.updateUserById(newUser.id, { ban_duration: "876000h" });
    return responseError("A confirmação de e-mail não está ativa para este projeto. O pedido não foi enviado ao Master.", 503);
  }

  const { error: detailsError } = await admin.from("access_request_details").insert({
    user_id: newUser.id,
    invite_id: inviteId,
    request_status: "pending_email",
  });
  if (detailsError) {
    await admin.auth.admin.deleteUser(newUser.id);
    return responseError("Não foi possível registrar a solicitação. Tente novamente.", 500);
  }

  // The email can be confirmed between signUp() returning and the request row
  // being written. Re-read only this newly-created Auth user to close that race;
  // never promote historical, administratively-confirmed accounts here.
  const { data: createdAuthUser, error: authReadError } = await admin.auth.admin.getUserById(newUser.id);
  if (authReadError || !createdAuthUser.user) {
    await admin.auth.admin.deleteUser(newUser.id);
    return responseError("Não foi possível verificar a solicitação. Tente novamente.", 503);
  }
  if (createdAuthUser.user.email_confirmed_at) {
    const { error: confirmationError } = await admin.from("access_request_details")
      .update({ request_status: "pending_review" })
      .eq("user_id", newUser.id)
      .eq("request_status", "pending_email");
    if (confirmationError) {
      await admin.auth.admin.deleteUser(newUser.id);
      return responseError("Não foi possível atualizar a confirmação do pedido. Tente novamente.", 503);
    }
  }

  const acceptedAt = new Date().toISOString();
  const { error: consentError } = await admin.from("user_consents").upsert({
    user_id: newUser.id,
    privacy_accepted_at: acceptedAt,
    privacy_version: legalVersions.privacy,
    terms_accepted_at: acceptedAt,
    terms_version: legalVersions.terms,
  }, { onConflict: "user_id" });
  if (consentError) {
    await admin.auth.admin.deleteUser(newUser.id);
    return responseError("Não foi possível registrar os consentimentos. Tente novamente.", 500);
  }

  return genericAccepted();
}
