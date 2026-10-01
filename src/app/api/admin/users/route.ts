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

const requestStatuses = ["pending", "pending_email", "verification_required"] as const;
const requestPageSize = 25;
const legacyRequestPageLimit = 1_000;

type MasterAccountPage = {
  items?: Array<Record<string, unknown>>;
  total?: number;
  page?: number;
  pageSize?: number;
  stats?: Record<string, number>;
};

async function listRequestsWithLegacyFilter(
  admin: ReturnType<typeof getSupabaseAdminClient>,
  search: string,
  page: number,
): Promise<MasterAccountPage | null> {
  const neededItems = page * requestPageSize;
  // Older deployed RPCs cap each query at 100 rows and do not accept the
  // combined `requests` filter. Bound compatibility work while the additive
  // database migration is rolling out.
  if (neededItems > legacyRequestPageLimit) return null;

  const batchCount = Math.ceil(neededItems / 100);
  const groups = await Promise.all(requestStatuses.map(async (status) => {
    const batches = await Promise.all(Array.from({ length: batchCount }, (_, index) =>
      admin.rpc("master_list_accounts", {
        p_search: search || null,
        p_status: status,
        p_page: index + 1,
        p_page_size: 100,
      })
    ));
    const failed = batches.find((batch) => batch.error || !batch.data);
    if (failed) return { error: true as const };

    return {
      error: false as const,
      items: batches.flatMap((batch) => ((batch.data as MasterAccountPage).items ?? [])),
      total: Number((batches[0].data as MasterAccountPage).total ?? 0),
      stats: (batches[0].data as MasterAccountPage).stats ?? {},
    };
  }));

  if (groups.some((group) => group.error)) return null;

  const accounts = groups.flatMap((group) => group.error ? [] : group.items);
  accounts.sort((left, right) => {
    const leftCreatedAt = Date.parse(String(left.created_at ?? ""));
    const rightCreatedAt = Date.parse(String(right.created_at ?? ""));
    if (leftCreatedAt !== rightCreatedAt && Number.isFinite(leftCreatedAt) && Number.isFinite(rightCreatedAt)) {
      return rightCreatedAt - leftCreatedAt;
    }
    return String(left.id ?? "").localeCompare(String(right.id ?? ""));
  });

  return {
    items: accounts.slice((page - 1) * requestPageSize, page * requestPageSize),
    total: groups.reduce((sum, group) => sum + (group.error ? 0 : group.total), 0),
    page,
    pageSize: requestPageSize,
    stats: groups.find((group) => !group.error)?.stats ?? {},
  };
}

function isUnsupportedCombinedRequestFilter(error: { message?: string } | null) {
  return error?.message?.toLowerCase().includes("invalid account filter") ?? false;
}

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
  if (parsed.data.status === "requests" && isUnsupportedCombinedRequestFilter(error)) {
    const compatiblePage = await listRequestsWithLegacyFilter(admin, parsed.data.search, parsed.data.page);
    if (!compatiblePage) return json({ error: "Não foi possível carregar as solicitações agora." }, 503);
    return json(compatiblePage);
  }
  if (error || !data) return json({ error: "Não foi possível carregar as contas agora." }, 503);
  return json(data);
}

function publicActionError(message: string, action: string) {
  if (message.includes("master authorization required")) return json({ error: "Sua sessão Master expirou. Entre novamente." }, 403);
  if (message.includes("account not found")) return json({ error: "Conta não encontrada." }, 404);
  if (message.includes("verified pending request required for archive")) return json({ error: "Só é possível arquivar uma solicitação que esteja aguardando análise." }, 409);
  if (message.includes("archived access request required")) return json({ error: "Só é possível reabrir uma solicitação arquivada." }, 409);
  if (message.includes("verified pending request required")) return json({ error: "A solicitação não está mais pendente. Atualize a fila e tente novamente." }, 409);
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

type ActionAuditOutcome = "completed" | "failed" | "needs_attention";

async function finishActionAudit(
  admin: ReturnType<typeof getSupabaseAdminClient>,
  actorId: string,
  auditId: string,
  outcome: "completed" | "failed",
  detailCode: string | null,
): Promise<{ recorded: boolean; outcome: ActionAuditOutcome | null }> {
  const finish = await admin.rpc("master_finish_admin_audit", {
    p_actor_id: actorId,
    p_audit_id: auditId,
    p_outcome: outcome,
    p_detail_code: detailCode,
  });
  if (!finish.error && finish.data === true) return { recorded: true, outcome };

  // A failure after the Auth side effect must not leave a silent or ambiguous
  // audit entry. Persist a retryable attention state whenever the DB is back.
  const attention = await admin.rpc("master_finish_admin_audit", {
    p_actor_id: actorId,
    p_audit_id: auditId,
    p_outcome: "needs_attention",
    p_detail_code: "audit_reconciliation_required",
  });
  if (!attention.error && attention.data === true) return { recorded: true, outcome: "needs_attention" };

  // Resolve an ambiguous network response: the first UPDATE may have committed
  // even when its response was lost. This is read-only and scoped to this actor.
  const persisted = await admin.from("master_audit_log")
    .select("outcome")
    .eq("id", auditId)
    .eq("actor_id", actorId)
    .maybeSingle();
  const persistedOutcome = persisted.data?.outcome;
  if (!persisted.error && (persistedOutcome === "completed" || persistedOutcome === "failed" || persistedOutcome === "needs_attention")) {
    return { recorded: true, outcome: persistedOutcome };
  }
  return { recorded: false, outcome: null };
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const master = await authorize(request);
  if (!master) return json({ error: "Não autorizado." }, 403);

  const parsed = actionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json({ error: "Ação inválida." }, 400);
  const { userId, action, reasonCode, reasonNote, reauthPassword } = parsed.data;
  if (userId === master.id) return json({ error: "Você não pode alterar a própria conta Master." }, 400);
  if (!reasonCode) return json({ error: "Registre o motivo desta decisão para a auditoria." }, 400);
  if (reasonCode === "other" && !reasonNote?.trim()) return json({ error: "Descreva o motivo quando selecionar “Outro motivo”." }, 400);
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
    approve: "Cadastro aprovado após análise manual do Master.",
    reject: "Solicitação recusada após análise manual do Master.",
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
      const authPatch = action === "approve" && transition.authAction === "unban"
        ? { email_confirm: true, ban_duration: banDuration }
        : { ban_duration: banDuration };
      const updated = await admin.auth.admin.updateUserById(userId, authPatch);
      authError = updated.error;
    }
  } catch {
    authError = { message: "auth operation failed" };
  }

  if (authError) {
    const detailCode = transition.authAction === "delete" ? "auth_delete_failed" : transition.authAction === "unban" ? "auth_unban_failed" : "auth_ban_failed";
    const audit = await finishActionAudit(admin, master.id, transition.auditId, "failed", detailCode);
    if (authError.message.includes("workspace owner must transfer ownership before deletion")) {
      return json({ error: "Esta conta ainda administra uma empresa com outros integrantes. Transfira a titularidade antes de excluir definitivamente." }, 409);
    }
    if (!audit.recorded) {
      return json({ error: "A ação precisa de reconciliação: não foi possível confirmar o resultado no histórico administrativo. Atualize a auditoria antes de repetir." }, 503);
    }
    if (audit.outcome === "needs_attention") return json({ error: "A autenticação não concluiu a alteração e o histórico marcou o caso para reconciliação. Atualize a auditoria para tentar novamente com segurança." }, 503);
    return json({ error: "A atualização não foi concluída no serviço de autenticação. O resultado foi registrado; tente novamente." }, 503);
  }

  const audit = await finishActionAudit(admin, master.id, transition.auditId, "completed", null);
  if (!audit.recorded) return json({ error: "A alteração no acesso foi executada, mas o histórico não confirmou o resultado. Atualize a auditoria antes de repetir." }, 503);
  if (audit.outcome === "needs_attention") return json({ error: "A alteração foi executada e o histórico marcou a confirmação para reconciliação. Atualize a auditoria e use a opção de nova tentativa." }, 503);
  if (audit.outcome !== "completed") return json({ error: "A alteração foi executada, mas a auditoria ainda não confirmou a conclusão. Atualize o histórico e tente reconciliar." }, 503);

  return json({ ok: true, action, auditId: transition.auditId });
}
