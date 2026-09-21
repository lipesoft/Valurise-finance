import { getSupabaseBrowserClient } from "@/lib/supabase/client";

export type ValuriseStateDocument<TData, TTransaction, TProfile> = {
  data: TData;
  transactions: TTransaction[];
  profile: TProfile;
};

/**
 * A small, versioned sync envelope used while the UI is progressively moved
 * from local persistence to normalized Supabase tables. RLS always keys it by
 * the authenticated user's UUID; no user id supplied by the browser is trusted.
 */
export async function loadValuriseState<TData, TTransaction, TProfile>() {
  const supabase = getSupabaseBrowserClient();
  if (!supabase) return null;
  const { data: auth, error: authError } = await supabase.auth.getUser();
  if (authError || !auth.user) return null;
  const { data, error } = await supabase
    .from("user_financial_state")
    .select("state")
    .eq("user_id", auth.user.id)
    .maybeSingle();
  if (error || !data?.state) return null;
  return data.state as ValuriseStateDocument<TData, TTransaction, TProfile>;
}

export async function saveValuriseState<TData, TTransaction, TProfile>(
  state: ValuriseStateDocument<TData, TTransaction, TProfile>,
) {
  const supabase = getSupabaseBrowserClient();
  if (!supabase) return { synced: false, reason: "not-configured" as const };
  const { data: auth, error: authError } = await supabase.auth.getUser();
  if (authError || !auth.user) return { synced: false, reason: "not-signed-in" as const };
  const { error } = await supabase.from("user_financial_state").upsert(
    { user_id: auth.user.id, state, version: 1 },
    { onConflict: "user_id" },
  );
  return error
    ? { synced: false, reason: "write-failed" as const }
    : { synced: true as const };
}
