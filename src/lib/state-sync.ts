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
  if (authError) throw new Error("Não foi possível validar sua sessão de sincronização.");
  if (!auth.user) throw new Error("Sua sessão expirou antes da sincronização.");
  const { data, error } = await supabase
    .from("user_financial_state")
    .select("state, version")
    .eq("user_id", auth.user.id)
    .maybeSingle();
  if (error) throw new Error("Não foi possível ler os dados financeiros sincronizados.");
  if (!data?.state) return null;
  return {
    state: data.state as ValuriseStateDocument<TData, TTransaction, TProfile>,
    version: data.version as number,
  };
}

export async function saveValuriseState<TData, TTransaction, TProfile>(
  state: ValuriseStateDocument<TData, TTransaction, TProfile>,
  expectedVersion: number | null = null,
) {
  const supabase = getSupabaseBrowserClient();
  if (!supabase) return { synced: false, reason: "not-configured" as const };
  const { data: auth, error: authError } = await supabase.auth.getUser();
  if (authError || !auth.user) return { synced: false, reason: "not-signed-in" as const };
  if (expectedVersion === null) {
    const { error } = await supabase.from("user_financial_state")
      .insert({ user_id: auth.user.id, state, version: 1 });
    if (error?.code === "23505") return { synced: false, reason: "conflict" as const };
    return error
      ? { synced: false, reason: "write-failed" as const }
      : { synced: true as const, version: 1 };
  }

  const { data, error } = await supabase.from("user_financial_state")
    .update({ state, version: expectedVersion + 1 })
    .eq("user_id", auth.user.id)
    .eq("version", expectedVersion)
    .select("version")
    .maybeSingle();
  if (error) return { synced: false, reason: "write-failed" as const };
  if (!data) return { synced: false, reason: "conflict" as const };
  return { synced: true as const, version: data.version as number };
}
