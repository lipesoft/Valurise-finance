import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSupabaseAdminClient, getVerifiedMaster } from "@/lib/supabase/admin";
import { verifyMasterPassword } from "@/lib/supabase/reauth";

export const dynamic = "force-dynamic";

const accountStatus = z.enum([
  "all",
  "requests",
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
  action: z.enum(["approve", "reject", "disable", "restore", "trash", "archive_request", "reopen_request", "delete_permanently"]),
  reasonCode: z.enum([
    "duplicate_request",
    "incomplete_request",
    "policy_violation",
    "security_concern",
    "user_requested",
    "other",
  ]).optional(),
  reasonNote: z.string().trim().max(280).optional(),
  reauthPassword: z.string().min(1).max(200).optional(),
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
  if (message.includes("verified pending request required for archive")) return json({ error: "Só é possível arquivar uma solicitação com e-mail confirmado e aguardando análise." }, 409);
  if (message.includes("archived access request required")) return json({ error: "Só é possível reabrir uma solicitação confirmada que esteja arquivada." }, 409);
  if (message.includes("verified pending request required")) return json({ error: "A solicitação só pode ser decidida depois da confirmação de e-mail." }, 409);
  if (message.includes("pending access request must be reopened")) return json({ error: "Esta solicitação ainda aguarda aprovação. Reabra o pedido na lixeira; não é possível ativar a conta diretamente." }, 409);
  if (message.includes("account must be in trash")) return json({ error: "Mova a conta para a lixeira antes de excluí-la definitivamente." }, 409);
  if (message.includes("linked invite unavailable")) return json({ error: "O convite vinculado expirou ou foi revogado. Revise a solicitação antes de aprovar." }, 409);
  if (message.includes("cannot manage own master account")) return json({ error: "Você não pode alterar a própria conta Master." }, 400);
  if (message.includes("workspace owner must transfer ownership before deletion")) {
    return json({ error: "Esta conta ainda administra uma empresa com outros integrantes. Transfira a titularidade antes de excluir definitivamente." }, 409);
  }
  const errors: Record<typeof action, string> = {
    approve: "Não foi possível aprovar o acesso. Atualize a fila e tente novamente.",
    reject: "Não foi possível recusar o pedido. Atualize a fila e tente novamente.",
    disable: "Não foi possível desativar a conta. Atualize a lista e tente novamente.",
    restore: "Não foi possível restaurar a conta. Atualize a lista e tente novamente.",
    trash: "Não foi possível mover a conta para a lixeira. Atualize a lista e tente novamente.",
    archive_request: "Não foi possível arquivar a solicitação. Ela permanece registrada e pode ser tentada novamente.",
    reopen_request: "Não foi possível reabrir a solicitação. Ela permanece na lixeira e pode ser tentada novamente.",
    delete_permanently: "Não foi possível excluir a conta. Ela continua na lixeira e pode ser tentada novamente.",
  };
  return json({ error: errors[action] }, 409);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const master = await authorize(request);
  if (!master) return json({ error: "Não autorizado." }, 403);

  const parsed = actionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json({ error: "Ação inválida." }, 400);
  const { userId, action, reasonCode, reasonNote, reauthPassword } = parsed.data;
  if (userId === master.id) return json({ error: "Você não pode alterar a própria conta Master." }, 400);
  if (!reasonCode) return json({ error: "Registre o motivo desta decisão para a auditoria." }, 400);
  if (action === "delete_permanently") {
    if (!reauthPassword) return json({ error: "Confirme sua senha Master para excluir definitivamente." }, 400);
    if (!master.email) return json({ error: "Não foi possível validar a reautenticação desta conta." }, 503);
    const verification = await verifyMasterPassword(master.id, master.email, reauthPassword);
    if (verification.unavailable) return json({ error: "Não foi possível confirmar sua senha agora. Tente novamente." }, 503);
    if (!verification.valid) return json({ error: "A senha de confirmação está incorreta." }, 401);
  }

  const admin = getSupabaseAdminClient();
  const transitionFunction = action === "archive_request"
    ? "master_archive_access_request"
    : action === "reopen_request"
      ? "master_reopen_access_request"
      : "master_transition_account";
  const actionAuditNotes: Partial<Record<typeof action, string>> = {
    approve: "Cadastro aprovado após confirmação de e-mail e análise do Master.",
    restore: "Conta reativada após revisão administrativa.",
    archive_request: `Solicitação confirmada arquivada: ${(reasonNote || "retirada da fila sem recusa.").slice(0, 220)}`,
    reopen_request: `Solicitação arquivada reaberta: ${(reasonNote || "devolvida à fila para nova análise.").slice(0, 220)}`,
  };
  const auditedReasonNote = action === "archive_request" || action === "reopen_request"
    ? actionAuditNotes[action]
    : reasonNote || actionAuditNotes[action] || null;
  const { data: transition, error: transitionError } = await admin.rpc(transitionFunction, {
    p_actor_id: master.id,
    p_target_user_id: userId,
    ...(transitionFunction === "master_transition_account" ? { p_action: action } : {}),
    p_reason_code: reasonCode ?? null,
    p_reason_note: auditedReasonNote,
  });
  if (transitionError || !transition?.auditId || !transition?.authAction) {
    if (!transitionError && transition?.alreadyCompleted && transition.auditId) {
      return json({ ok: true, action, replayed: true, auditId: transition.auditId });
    }
    return publicActionError(transitionError?.message ?? "invalid transition", action);
  }

  let authError: { message: string; code?: string; status?: number } | null = null;
  try {
    if (transition.authAction === "delete") {
      let userAlreadyMissing = false;
      if (transition.alreadyDeleted) {
        const existing = await admin.auth.admin.getUserById(userId);
        userAlreadyMissing = !existing.data?.user || Boolean(existing.error?.status === 404 && existing.error.code === "user_not_found");
        if (existing.error && !userAlreadyMissing) authError = existing.error;
      }
      if (!userAlreadyMissing && !authError) {
        const removed = await admin.auth.admin.deleteUser(userId);
        const deletionWasAlreadyComplete = removed.error?.status === 404 && removed.error.code === "user_not_found";
        authError = deletionWasAlreadyComplete ? null : removed.error;
      }
    } else {
      const banDuration = transition.authAction === "unban" ? "none" : "876000h";
      const updated = await admin.auth.admin.updateUserById(userId, { ban_duration: banDuration });
      authError = updated.error;
    }
  } catch {
    authError = { message: "auth operation failed" };
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
    if (audit.error || audit.data !== true) {
      return json({ error: "A ação precisa de reconciliação: não foi possível confirmar o resultado no histórico administrativo. Atualize a auditoria antes de repetir." }, 503);
    }
    return json({ error: "A atualização não foi concluída no serviço de autenticação. O resultado foi registrado; tente novamente." }, 503);
  }

  const { data: auditCompleted, error: auditError } = await admin.rpc("master_finish_admin_audit", {
    p_actor_id: master.id,
    p_audit_id: transition.auditId,
    p_outcome: "completed",
    p_detail_code: null,
  });
  if (auditError || auditCompleted !== true) return json({ error: "A alteração foi feita, mas a confirmação de auditoria precisa de atenção. Atualize o painel antes de repetir." }, 503);

  return json({ ok: true, action, auditId: transition.auditId });
}
