import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSupabaseAdminClient, getVerifiedActiveUser } from "@/lib/supabase/admin";

const schema = z.object({ workspaceId: z.string().uuid() }).strict();

export async function PUT(request: NextRequest) {
  const user = await getVerifiedActiveUser(request.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Não autorizado." }, { status: 401 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Selecione um workspace válido." }, { status: 400 });

  const admin = getSupabaseAdminClient();
  const { data: membership, error: membershipError } = await admin.from("workspace_memberships")
    .select("workspace_id")
    .eq("workspace_id", parsed.data.workspaceId)
    .eq("user_id", user.id)
    .eq("status", "active")
    .maybeSingle();
  if (membershipError) return NextResponse.json({ error: "Não foi possível validar sua associação." }, { status: 503 });
  if (!membership) return NextResponse.json({ error: "Você não tem acesso a este workspace." }, { status: 403 });

  const { data: workspace, error: workspaceError } = await admin.from("workspaces")
    .select("id")
    .eq("id", parsed.data.workspaceId)
    .is("archived_at", null)
    .maybeSingle();
  if (workspaceError || !workspace) return NextResponse.json({ error: "Este workspace não está disponível." }, { status: 404 });

  const { error } = await admin.from("user_active_workspaces").upsert({
    user_id: user.id,
    workspace_id: workspace.id,
    updated_at: new Date().toISOString(),
  }, { onConflict: "user_id" });
  if (error) return NextResponse.json({ error: "Não foi possível trocar o workspace ativo." }, { status: 503 });
  return NextResponse.json({ ok: true, activeWorkspaceId: workspace.id }, { headers: { "Cache-Control": "no-store" } });
}
