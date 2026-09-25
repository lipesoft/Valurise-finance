import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSupabaseAdminClient, getVerifiedActiveUser } from "@/lib/supabase/admin";
import { isValidCnpj, normalizeCnpj } from "@/lib/workspaces/cnpj";

const schema = z.object({
  tradeName: z.string().trim().min(2).max(120),
  legalName: z.string().trim().min(2).max(180),
  cnpj: z.string().trim().min(14).max(24),
}).strict();

export async function POST(request: NextRequest) {
  const user = await getVerifiedActiveUser(request.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Não autorizado." }, { status: 401 });
  if (Number(request.headers.get("content-length") || 0) > 4096) return NextResponse.json({ error: "O cadastro excede o tamanho permitido." }, { status: 413 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Informe nome fantasia, razão social e CNPJ." }, { status: 400 });
  const normalizedCnpj = normalizeCnpj(parsed.data.cnpj);
  if (!isValidCnpj(normalizedCnpj)) return NextResponse.json({ error: "Confira o CNPJ informado." }, { status: 400 });

  const admin = getSupabaseAdminClient();
  const { data, error } = await admin.rpc("create_business_workspace", {
    p_user_id: user.id,
    p_trade_name: parsed.data.tradeName,
    p_legal_name: parsed.data.legalName,
    p_cnpj: normalizedCnpj,
  });
  if (error) {
    if (error.code === "23505") return NextResponse.json({ error: "Já existe um workspace empresarial com esse CNPJ." }, { status: 409 });
    if (error.code === "42P01" || error.code === "PGRST202") return NextResponse.json({ error: "A estrutura multi-workspace ainda não foi aplicada no banco." }, { status: 503 });
    if (error.code === "22023") return NextResponse.json({ error: "Confira os dados empresariais e tente novamente." }, { status: 400 });
    console.error("Business workspace creation failed", JSON.stringify({ code: error.code || "UNKNOWN" }));
    return NextResponse.json({ error: "Não foi possível criar o workspace empresarial." }, { status: 503 });
  }
  return NextResponse.json({ ok: true, workspace: data }, { status: 201, headers: { "Cache-Control": "no-store" } });
}
