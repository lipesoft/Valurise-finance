import "server-only";

import { createClient } from "@supabase/supabase-js";

/** Creates a publishable-key client whose database requests carry the already-verified user's JWT. */
export function createUserScopedSupabaseClient(accessToken: string) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error("Supabase não está configurado.");

  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    accessToken: async () => accessToken,
    global: { headers: { "X-Client-Info": "valurise-personal-ai" } },
  });
}
