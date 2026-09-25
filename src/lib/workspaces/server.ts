import "server-only";

import { getSupabaseAdminClient, getVerifiedActiveUser } from "@/lib/supabase/admin";
import type { ActiveWorkspaceContext, WorkspaceRole, WorkspaceType } from "./types";

export type ActiveWorkspaceResult =
  | { ok: true; user: NonNullable<Awaited<ReturnType<typeof getVerifiedActiveUser>>>; workspace: ActiveWorkspaceContext }
  | { ok: false; status: 401 | 403 | 409 | 503; error: string };

const isMissingWorkspaceSchema = (code?: string) => code === "42P01" || code === "PGRST205" || code === "42703";

/** Resolve a requested workspace (or the saved default) and prove membership on every request. */
export async function getVerifiedWorkspaceContext(
  authorization: string | null,
  requestedWorkspaceId?: string | null,
): Promise<ActiveWorkspaceResult> {
  const user = await getVerifiedActiveUser(authorization);
  if (!user) return { ok: false, status: 401, error: "Não autorizado." };

  if (requestedWorkspaceId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestedWorkspaceId)) {
    return { ok: false, status: 403, error: "Você não tem acesso a este workspace." };
  }

  // The persisted selection is a startup preference, not an authorization
  // boundary. Other devices can keep using their explicitly selected workspace.
  const admin = getSupabaseAdminClient();
  let workspaceId = requestedWorkspaceId || undefined;
  if (!workspaceId) {
    const { data: selected, error: selectionError } = await admin
      .from("user_active_workspaces")
      .select("workspace_id")
      .eq("user_id", user.id)
      .maybeSingle();
    if (selectionError) {
      return isMissingWorkspaceSchema(selectionError.code)
        ? { ok: false, status: 503, error: "A estrutura de workspaces ainda não foi aplicada no banco." }
        : { ok: false, status: 503, error: "Não foi possível validar o workspace preferido." };
    }
    workspaceId = selected?.workspace_id as string | undefined;
  }
  if (!workspaceId) {
    const { data: personal, error } = await admin.from("workspaces")
      .select("id")
      .eq("owner_user_id", user.id)
      .eq("type", "personal")
      .is("archived_at", null)
      .maybeSingle();
    if (error || !personal) return { ok: false, status: 503, error: "Não há um workspace pessoal disponível para esta conta." };
    workspaceId = personal.id;
    const { error: saveError } = await admin.from("user_active_workspaces")
      .upsert({ user_id: user.id, workspace_id: workspaceId, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
    if (saveError) return { ok: false, status: 503, error: "Não foi possível ativar seu workspace pessoal." };
  }

  const [{ data: membership, error: membershipError }, { data: workspace, error: workspaceError }] = await Promise.all([
    admin.from("workspace_memberships").select("role, status")
      .eq("workspace_id", workspaceId).eq("user_id", user.id).maybeSingle(),
    admin.from("workspaces").select("id, type, display_name, archived_at")
      .eq("id", workspaceId).maybeSingle(),
  ]);
  if (membershipError || workspaceError) return { ok: false, status: 503, error: "Não foi possível validar o workspace solicitado." };
  if (!membership || membership.status !== "active") return { ok: false, status: 403, error: "Você não tem acesso a este workspace." };
  if (!workspace || workspace.archived_at) return { ok: false, status: 409, error: "Este workspace não está disponível." };
  return {
    ok: true,
    user,
    workspace: {
      userId: user.id,
      id: workspace.id,
      type: workspace.type as WorkspaceType,
      displayName: workspace.display_name,
      role: membership.role as WorkspaceRole,
    },
  };
}
