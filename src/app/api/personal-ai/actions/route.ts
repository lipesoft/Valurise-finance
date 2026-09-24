import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSupabaseAdminClient, getVerifiedActiveUser } from "@/lib/supabase/admin";

const decisionSchema = z.object({
  proposalId: z.string().uuid(),
  decision: z.enum(["approve", "reject"]),
}).strict();

export async function GET(request: NextRequest) {
  const user = await getVerifiedActiveUser(request.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Não autorizado." }, { status: 401 });

  const admin = getSupabaseAdminClient();
  const [{ data: connection, error: connectionError }, { data: proposals, error: proposalError }] = await Promise.all([
    admin.from("personal_ai_connections").select("actions_enabled").eq("user_id", user.id).maybeSingle(),
    admin.from("personal_ai_action_proposals")
      .select("id, action_type, amount_cents, category, account_label, description, transaction_date, created_at, expires_at")
      .eq("user_id", user.id).eq("status", "pending").gt("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false }).limit(5),
  ]);
  if (connectionError || proposalError) return NextResponse.json({ error: "Não foi possível carregar as propostas da Val." }, { status: 503 });
  if (!connection?.actions_enabled) {
    await admin.from("personal_ai_action_proposals").update({ status: "cancelled", acted_at: new Date().toISOString() })
      .eq("user_id", user.id).eq("status", "pending");
    return NextResponse.json({ proposals: [] });
  }
  return NextResponse.json({ proposals: (proposals || []).map((proposal) => ({
    ...proposal,
    amount_cents: Number(proposal.amount_cents),
  })) });
}

export async function POST(request: NextRequest) {
  const authorization = request.headers.get("authorization");
  const user = await getVerifiedActiveUser(authorization);
  if (!user) return NextResponse.json({ error: "Não autorizado." }, { status: 401 });
  if (Number(request.headers.get("content-length") || 0) > 1024) return NextResponse.json({ error: "A confirmação excede o tamanho permitido." }, { status: 413 });
  const rawBody = await request.text().catch(() => "");
  if (rawBody.length > 1024) return NextResponse.json({ error: "A confirmação excede o tamanho permitido." }, { status: 413 });
  let body: unknown = null;
  try { body = JSON.parse(rawBody); } catch { return NextResponse.json({ error: "A confirmação não é válida." }, { status: 400 }); }
  const parsed = decisionSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "A confirmação não é válida." }, { status: 400 });

  const admin = getSupabaseAdminClient();
  if (parsed.data.decision === "reject") {
    const { data, error } = await admin.from("personal_ai_action_proposals")
      .update({ status: "rejected", acted_at: new Date().toISOString() })
      .eq("id", parsed.data.proposalId).eq("user_id", user.id).eq("status", "pending")
      .select("id").maybeSingle();
    if (error) return NextResponse.json({ error: "Não foi possível descartar a proposta." }, { status: 503 });
    if (!data) return NextResponse.json({ error: "A proposta expirou ou já foi respondida." }, { status: 409 });
    return NextResponse.json({ ok: true, decision: "rejected" });
  }

  try {
    const { data, error } = await admin.rpc("confirm_personal_ai_transaction", {
      p_proposal_id: parsed.data.proposalId,
      p_user_id: user.id,
    });
    if (error) return NextResponse.json({ error: "Não foi possível confirmar a proposta. Atualize os dados e tente novamente." }, { status: 503 });
    const result = data as { ok?: boolean; reason?: string; version?: number; transaction?: unknown } | null;
    if (!result?.ok) {
      const messages: Record<string, string> = {
        not_pending: "Esta proposta já foi respondida.",
        expired: "O prazo da proposta terminou. Peça à Val para preparar outra.",
        permission_revoked: "A permissão de ações ou o consentimento financeiro foi desativado.",
        state_missing: "Não há dados sincronizados para aplicar esta proposta.",
        state_changed: "Seus dados mudaram desde que a proposta foi criada. Peça uma nova proposta para evitar alterar informações desatualizadas.",
        details_changed: "A conta ou categoria mudou. Peça uma nova proposta à Val.",
      };
      const status = result?.reason === "not_pending" || result?.reason === "expired" ? 409 : 422;
      return NextResponse.json({ error: messages[result?.reason || ""] || "A proposta não pôde ser aplicada." }, { status });
    }
    return NextResponse.json({ ok: true, version: result.version, transaction: result.transaction });
  } catch {
    return NextResponse.json({ error: "A confirmação segura está indisponível no momento." }, { status: 503 });
  }
}
