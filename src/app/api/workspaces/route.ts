import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getVerifiedWorkspaceContext } from "@/lib/workspaces/server";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const active = await getVerifiedWorkspaceContext(request.headers.get("authorization"));
  if (!active.ok) return NextResponse.json({ error: active.error }, { status: active.status, headers: { "Cache-Control": "no-store" } });

  const admin = getSupabaseAdminClient();
  const { data: memberships, error: membershipError } = await admin.from("workspace_memberships")
    .select("workspace_id, role")
    .eq("user_id", active.user.id)
    .eq("status", "active");
  if (membershipError) return NextResponse.json({ error: "Não foi possível carregar seus workspaces." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  const ids = (memberships || []).map((membership) => membership.workspace_id);
  if (!ids.length) return NextResponse.json({ error: "Nenhum workspace está disponível para esta conta." }, { status: 409, headers: { "Cache-Control": "no-store" } });
  const { data: workspaces, error } = await admin.from("workspaces")
    .select("id, type, display_name")
    .in("id", ids)
    .is("archived_at", null)
    .order("created_at", { ascending: true });
  if (error) return NextResponse.json({ error: "Não foi possível carregar seus workspaces." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  const roleByWorkspace = new Map((memberships || []).map((item) => [item.workspace_id, item.role]));
  return NextResponse.json({
    activeWorkspaceId: active.workspace.id,
    workspaces: (workspaces || []).map((workspace) => ({
      id: workspace.id,
      type: workspace.type,
      displayName: workspace.display_name,
      role: roleByWorkspace.get(workspace.id) || "viewer",
    })),
  }, { headers: { "Cache-Control": "no-store" } });
}
