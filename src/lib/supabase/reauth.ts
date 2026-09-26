import "server-only";

import { createClient } from "@supabase/supabase-js";

export async function verifyMasterPassword(userId: string, email: string, password: string) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !publishableKey) return { valid: false, unavailable: true };

  try {
    const auth = createClient(url, publishableKey, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    });
    const { data, error } = await auth.auth.signInWithPassword({ email, password });
    return { valid: !error && data.user?.id === userId, unavailable: false };
  } catch {
    return { valid: false, unavailable: true };
  }
}
