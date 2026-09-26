import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSupabaseAdminClient, getVerifiedMaster } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const accountStatus = z.enum([
  "all",
  "pending",
  "pending_email",
  "verification_required",
  "active",
  "disabled",
  "trashed",
  "rejected",
]);
const actionSchema = z.object({
  userId: z.string().uuid(),
  action: z.enum(["approve", "reject", "disable", "restore", "trash", "delete_permanently"]),
  reasonCode: z.enum([
    "duplicate_request",
    "incomplete_request",
    "policy_violation",
    "security_concern",
    "user_requested",
    "other",
  ]).optional(),
  reasonNote: z.string().trim().max(280).optional(),
});

const json = (body: unknown, status = 200) => NextResponse.json(body, {
  status,
  headers: { "Cache-Control": "no-store, max-age=0" },
});

async function authorize(request: NextRequest) {
  return getVerifiedMaster(request.headers.get("authorization"));
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const master = await authorize(request);
  if (!master) return json({ error: "Não autorizado." }, 403);

  const params = request.nextUrl.searchParams;
  const parsed = z.object({
    search: z.string().trim().max(100).default(""),
    status: accountStatus.default("all"),
    page: z.coerce.number().int().min(1).max(100_000).default(1),
  }).safeParse({
    search: params.get("search") ?? "",
    status: params.get("status") ?? "all",
    page: params.get("page") ?? "1",
  });
  if (!parsed.success) return json({ error: "Filtro inválido." }, 400);

  const admin = getSupabaseAdminClient();
  const { data, error } = await admin.rpc("master_list_accounts", {
    p_search: parsed.data.search || null,
    p_status: parsed.data.status,
    p_page: parsed.data.page,
    p_page_size: 25,
  });
  if (error || !data) return json({ error: "Não foi possível carregar as contas agora." }, 503);
  return json(data);
}

function publicActionError(message: string, action: string) {
  if (message.includes("master authorization required")) return json({ error: "Sua sessão Master expirou. Entre novamente." }, 403);
  if (message.includes("account not found")) return json({ error: "Conta não encontrada." }, 404);
  if (message.includes("verified pending request required")) return json({ error: "A solicitação só pode ser decidida depois da confirmação de e-mail." }, 409);
  if (message.includes("account must be in trash")) return json({ error: "Mova a conta para a lixeira antes de excluí-la definitivamente." }, 409);
  if (message.includes("linked invite unavailable")) return json({ error: "O convite vinculado expirou ou foi revogado. Revise a solicitação antes de aprovar." }, 409);
  if (message.includes("cannot manage own master account")) return json({ error: "Você não pode alterar a própria conta Master." }, 400);
  if (message.includes("workspace owner must transfer ownership before deletion")) {
    return json({ error: "Esta conta ainda administra uma empresa com outros integrantes. Transfira a titularidade antes de excluir definitivamente." }, 409);
  }
  return json({ error: action === "delete_permanently" ? "Não foi possível excluir a conta. Ela continua na lixeira e pode ser tentada novamente." : "Não foi possível concluir esta ação. Atualize a lista e tente novamente." }, 409);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const master = await authorize(request);
  if (!master) return json({ error: "Não autorizado." }, 403);

  const parsed = actionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json({ error: "Ação inválida." }, 400);
  const { userId, action, reasonCode, reasonNote } = parsed.data;
  if (userId === master.id) return json({ error: "Você não pode alterar a própria conta Master." }, 400);
  if (["reject", "disable", "trash", "delete_permanently"].includes(action) && !reasonCode) {
    return json({ error: "Selecione um motivo para esta ação." }, 400);
  }

  const admin = getSupabaseAdminClient();
  const { data: transition, error: transitionError } = await admin.rpc("master_transition_account", {
    p_actor_id: master.id,
    p_target_user_id: userId,
    p_action: action,
    p_reason_code: reasonCode ?? null,
    p_reason_note: reasonNote || null,
  });
  if (transitionError || !transition?.auditId || !transition?.authAction) {
    return publicActionError(transitionError?.message ?? "invalid transition", action);
  }

  let authError: { message: string } | null = null;
  if (transition.authAction === "delete") {
    if (!transition.alreadyDeleted) {
      const removed = await admin.auth.admin.deleteUser(userId);
      authError = removed.error;
    }
  } else {
    const banDuration = transition.authAction === "unban" ? "none" : "876000h";
    const updated = await admin.auth.admin.updateUserById(userId, { ban_duration: banDuration });
    authError = updated.error;
  }

  if (authError) {
    const audit = await admin.rpc("master_finish_admin_audit", {
      p_actor_id: master.id,
      p_audit_id: transition.auditId,
      p_outcome: "failed",
      p_detail_code: transition.authAction === "delete" ? "auth_delete_failed" : transition.authAction === "unban" ? "auth_unban_failed" : "auth_ban_failed",
    });
    if (authError.message.includes("workspace owner must transfer ownership before deletion")) {
      return json({ error: "Esta conta ainda administra uma empresa com outros integrantes. Transfira a titularidade antes de excluir definitivamente." }, 409);
    }
    return json({
      error: audit.error
        ? "A ação foi iniciada, mas o registro de auditoria precisa de atenção. Atualize o painel antes de repetir."
        : "A atualização não foi concluída no serviço de autenticação. O resultado foi registrado; tente novamente.",
    }, 503);
  }

  const { error: auditError } = await admin.rpc("master_finish_admin_audit", {
    p_actor_id: master.id,
    p_audit_id: transition.auditId,
    p_outcome: "completed",
    p_detail_code: null,
  });
  if (auditError) return json({ error: "A alteração foi feita, mas a confirmação de auditoria precisa de atenção. Atualize o painel." }, 503);

  return json({ ok: true, action, auditId: transition.auditId });
}
