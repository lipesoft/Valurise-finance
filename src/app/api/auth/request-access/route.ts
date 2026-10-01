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
// Version the buckets when the policy changes so applicants blocked under the
// older 10/IP + 4/email limits are not kept blocked by stale counters.
const RATE_LIMITS = { ip: 20, email: 8, windowSeconds: 3600 } as const;

async function consumeLimit(admin: ReturnType<typeof getSupabaseAdminClient>, key: string, attempts: number) {
  return admin.rpc("consume_public_rate_limit", {
    p_key: key,
    p_max_attempts: attempts,
    p_window_seconds: RATE_LIMITS.windowSeconds,
  });
}

const responseError = (message: string, status: number) => NextResponse.json({ error: message }, { status });
function rateLimited(scope: "ip" | "email") {
  // Keep logs useful for operations without writing the visitor's IP or email.
  console.warn("[auth.request-access.rate-limited]", { scope });
  return NextResponse.json(
    { error: "Você atingiu o limite de tentativas de cadastro. Aguarde até 1 hora e tente novamente." },
    { status: 429, headers: { "Retry-After": "3600", "Cache-Control": "no-store, max-age=0" } },
  );
}

/** Creates a blocked account and sends the request straight to Master review. */
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
  const addressLimit = await consumeLimit(admin, bucket("access-request:v2:ip", clientAddress), RATE_LIMITS.ip);
  if (addressLimit.error) return responseError("Cadastro temporariamente indisponível. Tente novamente mais tarde.", 503);
  if (addressLimit.data !== true) return rateLimited("ip");

  if (!/^[a-z0-9._-]{3,32}$/.test(username)) return responseError("Escolha um usuário com pelo menos 3 caracteres.", 400);
  const { data: existingUsername, error: usernameError } = await admin
    .from("profiles")
    .select("id")
    .eq("username", username)
    .maybeSingle();
  if (usernameError) return responseError("Cadastro temporariamente indisponível. Tente novamente mais tarde.", 503);
  if (existingUsername) {
    // Unlike duplicate e-mail responses, a username conflict must be actionable:
    // otherwise the UI says "Próximo passo" even though no Auth user or request
    // was created. Keep the response free of the existing account's identity.
    console.info("[auth.request-access.rejected]", { reason: "username_conflict" });
    return responseError(
      "Não foi possível iniciar o cadastro com esses dados. Confira o usuário escolhido ou, se já tiver uma conta, entre ou recupere sua senha.",
      409,
    );
  }

  const emailLimit = await consumeLimit(admin, bucket("access-request:v2:email", email), RATE_LIMITS.email);
  if (emailLimit.error) return responseError("Cadastro temporariamente indisponível. Tente novamente mais tarde.", 503);
  if (emailLimit.data !== true) return rateLimited("email");

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

  // Admin creation does not send a verification email. Explicitly keep the
  // account unconfirmed and banned at creation so project-level Auth settings
  // cannot create a sign-in window before the Master reviews the request.
  let created: Awaited<ReturnType<typeof admin.auth.admin.createUser>>["data"];
  let signupError: Awaited<ReturnType<typeof admin.auth.admin.createUser>>["error"];
  try {
    const result = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: false,
      ban_duration: "876000h",
      user_metadata: { full_name: fullName, username },
    });
    created = result.data;
    signupError = result.error;
  } catch {
    return responseError("Não foi possível registrar sua solicitação agora. Tente novamente mais tarde.", 503);
  }

  if (signupError) {
    if (["user_already_exists", "email_exists"].includes(signupError.code ?? "") || signupError.message.toLowerCase().includes("already registered")) return genericAccepted();
    return responseError("Não foi possível registrar sua solicitação agora. Tente novamente mais tarde.", 503);
  }
  const newUser = created.user;
  if (!newUser?.id) return responseError("Não foi possível registrar sua solicitação agora. Tente novamente mais tarde.", 503);

  const { error: detailsError } = await admin.from("access_request_details").insert({
    user_id: newUser.id,
    invite_id: inviteId,
    request_status: "pending_review",
  });
  if (detailsError) {
    await admin.auth.admin.deleteUser(newUser.id);
    return responseError("Não foi possível registrar a solicitação. Tente novamente.", 500);
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
