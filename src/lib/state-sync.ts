import { getSupabaseBrowserClient } from "@/lib/supabase/client";

export type ValuriseStateDocument<TData, TTransaction, TProfile> = {
  data: TData;
  transactions: TTransaction[];
  profile: TProfile;
};

export type FinancialWorkspaceRef = { id: string; type: "personal" | "business" };

/**
 * A small, versioned sync envelope used while the UI is progressively moved
 * from local persistence to normalized Supabase tables. RLS always scopes it
 * to the server-selected workspace and active membership; no owner id supplied
 * by the browser is used to decide which financial state may be read or written.
 */
export async function loadValuriseState<TData, TTransaction, TProfile>(workspaceId: string) {
  const supabase = getSupabaseBrowserClient();
  if (!supabase) return null;
  const { data: auth, error: authError } = await supabase.auth.getUser();
  if (authError) throw new Error("Não foi possível validar sua sessão de sincronização.");
  if (!auth.user) throw new Error("Sua sessão expirou antes da sincronização.");
  const { data, error } = await supabase
    .from("user_financial_state")
    .select("state, version")
    .eq("workspace_id", workspaceId)
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
  workspace: FinancialWorkspaceRef,
  expectedVersion: number | null = null,
) {
  const supabase = getSupabaseBrowserClient();
  if (!supabase) return { synced: false, reason: "not-configured" as const };
  const { data: auth, error: authError } = await supabase.auth.getUser();
  if (authError || !auth.user) return { synced: false, reason: "not-signed-in" as const };
  if (expectedVersion === null) {
    const { error } = await supabase.from("user_financial_state")
      .insert({ workspace_id: workspace.id, user_id: workspace.type === "personal" ? auth.user.id : null, state, version: 1 });
    if (error?.code === "23505") return { synced: false, reason: "conflict" as const };
    return error
      ? { synced: false, reason: "write-failed" as const }
      : { synced: true as const, version: 1 };
  }

  const { data, error } = await supabase.from("user_financial_state")
    .update({ state, version: expectedVersion + 1 })
    .eq("workspace_id", workspace.id)
    .eq("version", expectedVersion)
    .select("version")
    .maybeSingle();
  if (error) return { synced: false, reason: "write-failed" as const };
  if (!data) return { synced: false, reason: "conflict" as const };
  return { synced: true as const, version: data.version as number };
}
