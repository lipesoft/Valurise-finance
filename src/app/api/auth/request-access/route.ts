import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { normalizeUsername } from "@/lib/auth/username";

const requestSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  username: z.string(),
  email: z.string().trim().email().max(254),
  password: z.string().min(8).max(200),
});

/**
 * Public registration creates a real Supabase Auth user, already banned, and
 * a database-owned pending profile. The password goes straight to Supabase
 * Auth and is never stored by Valurise. Only a Master approval can unban it.
 */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const parsed = requestSchema.safeParse(body && {
    ...body,
    username: normalizeUsername(typeof body.username === "string" ? body.username : ""),
  });
  if (!parsed.success) {
    return NextResponse.json({ error: "Confira nome, e-mail, usuário e senha (mínimo de 8 caracteres)." }, { status: 400 });
  }

  const { fullName, username, email, password } = parsed.data;
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
    return NextResponse.json({ error: "Escolha um usuário com pelo menos 3 caracteres." }, { status: 400 });
  }
  const admin = getSupabaseAdminClient();
  const { data: existingUsername } = await admin
    .from("profiles")
    .select("id")
    .eq("username", username)
    .maybeSingle();
  if (existingUsername) return NextResponse.json({ error: "Este usuário já está em uso." }, { status: 409 });

  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    ban_duration: "876000h",
    user_metadata: { full_name: fullName, username },
  });
  if (createError || !created.user) {
    const message = createError?.message.toLowerCase().includes("already")
      ? "Este e-mail já possui um cadastro."
      : "Não foi possível enviar a solicitação. Tente novamente.";
    return NextResponse.json({ error: message }, { status: 400 });
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
    // Do not leave an Auth-only user behind: that would create a request the
    // Master cannot safely approve or even see.
    await admin.auth.admin.deleteUser(created.user.id);
    return NextResponse.json({ error: "Cadastro criado, mas a solicitação não pôde ser registrada. Tente novamente." }, { status: 500 });
  }

  return NextResponse.json({ ok: true }, { status: 201 });
}
