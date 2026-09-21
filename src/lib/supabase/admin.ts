import "server-only";

import { createClient } from "@supabase/supabase-js";

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} não está configurada.`);
  return value;
}

/** Server-only client. Never import this module in a Client Component. */
export function getSupabaseAdminClient() {
  return createClient(
    required("NEXT_PUBLIC_SUPABASE_URL"),
    required("SUPABASE_SECRET_KEY"),
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

export async function getVerifiedMaster(authorization: string | null) {
  const token = authorization?.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;

  const admin = getSupabaseAdminClient();
  const { data: auth, error: authError } = await admin.auth.getUser(token);
  if (authError || !auth.user) return null;

  const { data: profile } = await admin
    .from("profiles")
    .select("id, account_role, account_status")
    .eq("id", auth.user.id)
    .maybeSingle();

  return profile?.account_role === "master" && profile.account_status === "active"
    ? auth.user
    : null;
}

/** Verifies a bearer token and checks database-owned account status. */
export async function getVerifiedActiveUser(authorization: string | null) {
  const token = authorization?.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;

  const admin = getSupabaseAdminClient();
  const { data: auth, error: authError } = await admin.auth.getUser(token);
  if (authError || !auth.user) return null;

  const { data: profile } = await admin
    .from("profiles")
    .select("id, account_role, account_status")
    .eq("id", auth.user.id)
    .maybeSingle();

  if (!profile || profile.account_status !== "active" || profile.account_role !== "user") return null;
  return auth.user;
}
