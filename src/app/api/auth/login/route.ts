import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { normalizeUsername } from "@/lib/auth/username";

const payloadSchema = z.object({
  identifier: z.string().trim().min(1).max(120),
  password: z.string().min(1).max(200),
});

const invalidCredentials = () =>
  NextResponse.json({ error: "Login ou senha inválidos." }, { status: 401 });

/**
 * Resolves a public username privately on the server, then delegates password
 * verification to Supabase Auth. The response never reveals whether a username
 * or email exists, and no password is stored or compared by this application.
 */
export async function POST(request: NextRequest) {
  const parsed = payloadSchema.safeParse(await request.json());
  if (!parsed.success) return invalidCredentials();

  const { identifier, password } = parsed.data;
  let email = identifier.toLowerCase();

  try {
    if (!identifier.includes("@")) {
      const admin = getSupabaseAdminClient();
      const { data: profile } = await admin
        .from("profiles")
        .select("id")
        .eq("username", normalizeUsername(identifier))
        .maybeSingle();
      if (!profile?.id) return invalidCredentials();
      const { data: authUser } = await admin.auth.admin.getUserById(profile.id);
      if (!authUser.user?.email) return invalidCredentials();
      email = authUser.user.email;
    }

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    if (!url || !publishableKey) {
      return NextResponse.json({ error: "Autenticação indisponível." }, { status: 503 });
    }
    const authClient = createClient(url, publishableKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data, error } = await authClient.auth.signInWithPassword({ email, password });
    if (error || !data.session || !data.user) return invalidCredentials();

    return NextResponse.json({ session: data.session, user: data.user });
  } catch {
    return invalidCredentials();
  }
}
