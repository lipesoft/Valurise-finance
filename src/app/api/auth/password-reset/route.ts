import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

const schema = z.object({ email: z.string().trim().email().max(254) });
const neutralResponse = () => NextResponse.json({ ok: true });
const keyFor = (scope: string, value: string) => createHash("sha256").update(`${scope}\0${value}`).digest("hex");

export async function POST(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (origin && new URL(origin).origin !== request.nextUrl.origin) return NextResponse.json({ error: "Solicitação inválida." }, { status: 403 });
  if (Number(request.headers.get("content-length") || 0) > 4_000) return NextResponse.json({ error: "Solicitação inválida." }, { status: 413 });
  const raw = await request.text().catch(() => "");
  if (raw.length > 4_000) return NextResponse.json({ error: "Solicitação inválida." }, { status: 413 });
  let body: unknown = null;
  try { body = JSON.parse(raw); } catch { return NextResponse.json({ error: "E-mail inválido." }, { status: 400 }); }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "E-mail inválido." }, { status: 400 });

  try {
    const admin = getSupabaseAdminClient();
    const address = request.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim()
      || request.headers.get("x-real-ip") || "unknown";
    const limits = await Promise.all([
      admin.rpc("consume_public_rate_limit", { p_key: keyFor("reset-ip", address), p_max_attempts: 10, p_window_seconds: 3600 }),
      admin.rpc("consume_public_rate_limit", { p_key: keyFor("reset-email-ip", `${parsed.data.email.toLowerCase()}\0${address}`), p_max_attempts: 3, p_window_seconds: 3600 }),
    ]);
    if (limits.some(({ error }) => error)) return NextResponse.json({ error: "Recuperação temporariamente indisponível." }, { status: 503 });
    if (limits.some(({ data }) => data !== true)) return NextResponse.json({ error: "Muitas tentativas. Aguarde uma hora antes de tentar novamente." }, { status: 429, headers: { "Retry-After": "3600" } });

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    if (!url || !publishableKey) return NextResponse.json({ error: "Recuperação temporariamente indisponível." }, { status: 503 });
    const auth = createClient(url, publishableKey, { auth: { autoRefreshToken: false, persistSession: false } });
    const { error } = await auth.auth.resetPasswordForEmail(parsed.data.email, { redirectTo: `${request.nextUrl.origin}/?reset-password=1` });
    if (error) return NextResponse.json({ error: "Recuperação temporariamente indisponível." }, { status: 503 });
    // Keep the response identical whether or not the address exists.
    return neutralResponse();
  } catch {
    return NextResponse.json({ error: "Recuperação temporariamente indisponível." }, { status: 503 });
  }
}
