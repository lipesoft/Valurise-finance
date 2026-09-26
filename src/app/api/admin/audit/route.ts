import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSupabaseAdminClient, getVerifiedMaster } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const master = await getVerifiedMaster(request.headers.get("authorization"));
  if (!master) return NextResponse.json({ error: "Não autorizado." }, { status: 403 });

  const params = request.nextUrl.searchParams;
  const parsed = z.object({
    page: z.coerce.number().int().min(1).max(100_000).default(1),
    action: z.enum([
      "approved", "rejected", "disabled", "restored", "trashed",
      "permanently_deleted", "invite_created", "invite_revoked",
    ]).optional(),
  }).safeParse({ page: params.get("page") ?? "1", action: params.get("action") || undefined });
  if (!parsed.success) return NextResponse.json({ error: "Filtro inválido." }, { status: 400 });

  const admin = getSupabaseAdminClient();
  const { data, error } = await admin.rpc("master_list_audit", {
    p_actor_id: master.id,
    p_page: parsed.data.page,
    p_page_size: 25,
    p_action: parsed.data.action ?? null,
  });
  if (error || !data) return NextResponse.json({ error: "Não foi possível carregar a auditoria." }, { status: 503 });
  return NextResponse.json(data, { headers: { "Cache-Control": "no-store, max-age=0" } });
}
