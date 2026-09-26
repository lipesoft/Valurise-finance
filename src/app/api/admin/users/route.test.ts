import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { admin, getVerifiedMaster, verifyMasterPassword } = vi.hoisted(() => {
  const rpc = vi.fn();
  const from = vi.fn();
  const deleteUser = vi.fn();
  const getUserById = vi.fn();
  const updateUserById = vi.fn();
  return {
    admin: { rpc, from, auth: { admin: { deleteUser, getUserById, updateUserById } } },
    getVerifiedMaster: vi.fn(),
    verifyMasterPassword: vi.fn(),
  };
});

vi.mock("@/lib/supabase/admin", () => ({
  getSupabaseAdminClient: () => admin,
  getVerifiedMaster,
}));
vi.mock("@/lib/supabase/reauth", () => ({ verifyMasterPassword }));

import { GET, POST } from "./route";

const actorId = "00000000-0000-4000-8000-000000000001";
const accountId = "00000000-0000-4000-8000-000000000002";

function post(body: unknown) {
  return new NextRequest("http://localhost/api/admin/users", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer fake-token" },
    body: JSON.stringify(body),
  });
}

describe("GET /api/admin/users", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    admin.rpc.mockResolvedValue({ data: null, error: null });
    admin.from.mockReturnValue({
      select: () => ({
        eq: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
        }),
      }),
    });
    getVerifiedMaster.mockResolvedValue({ id: actorId, email: "master@example.invalid" });
  });

  it("encaminha busca, filtro e página para a consulta paginada do banco", async () => {
    admin.rpc.mockResolvedValueOnce({ data: { items: [], total: 206, page: 9, pageSize: 25 }, error: null });
    const request = new NextRequest("http://localhost/api/admin/users?search=filip&status=active&page=9", {
      headers: { Authorization: "Bearer fake-token" },
    });

    const response = await GET(request);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ total: 206, page: 9, pageSize: 25 });
    expect(admin.rpc).toHaveBeenCalledWith("master_list_accounts", {
      p_search: "filip",
      p_status: "active",
      p_page: 9,
      p_page_size: 25,
    });
  });

  it("rejeita filtros ou páginas inválidas sem consultar o banco", async () => {
    const invalidFilter = await GET(new NextRequest("http://localhost/api/admin/users?status=unknown"));
    const invalidPage = await GET(new NextRequest("http://localhost/api/admin/users?page=0"));

    expect(invalidFilter.status).toBe(400);
    expect(invalidPage.status).toBe(400);
    expect(admin.rpc).not.toHaveBeenCalled();
  });
});

describe("POST /api/admin/users", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    admin.rpc.mockResolvedValue({ data: null, error: null });
    admin.from.mockReturnValue({
      select: () => ({
        eq: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
        }),
      }),
    });
    getVerifiedMaster.mockResolvedValue({ id: actorId, email: "master@example.invalid" });
    verifyMasterPassword.mockResolvedValue({ valid: true, unavailable: false });
  });

  it("exige motivo antes de iniciar ações sensíveis", async () => {
    const response = await POST(post({ userId: accountId, action: "delete_permanently" }));

    expect(response.status).toBe(400);
    expect(admin.rpc).not.toHaveBeenCalled();
    expect(admin.auth.admin.deleteUser).not.toHaveBeenCalled();
  });

  it("exige justificativa antes de registrar qualquer decisão ou mudança de acesso", async () => {
    for (const action of ["approve", "reject", "disable", "restore", "trash", "archive_request", "reopen_request", "delete_permanently"]) {
      const response = await POST(post({ userId: accountId, action }));
      expect(response.status, action).toBe(400);
      expect((await response.json()).error).toMatch(/motivo/i);
    }

    expect(admin.rpc).not.toHaveBeenCalled();
    expect(admin.auth.admin.updateUserById).not.toHaveBeenCalled();
    expect(admin.auth.admin.deleteUser).not.toHaveBeenCalled();
  });

  it("exige detalhe quando o motivo é Outro", async () => {
    const response = await POST(post({ userId: accountId, action: "approve", reasonCode: "other" }));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/descreva o motivo/i);
    expect(admin.rpc).not.toHaveBeenCalled();
  });

  it("arquiva pedido confirmado sem recusá-lo, exige auditoria e bloqueia a conta", async () => {
    admin.rpc
      .mockResolvedValueOnce({ data: { auditId: "audit-archive", authAction: "ban", retry: false }, error: null })
      .mockResolvedValueOnce({ data: true, error: null });
    admin.auth.admin.updateUserById.mockResolvedValue({ data: { user: { id: accountId } }, error: null });

    const response = await POST(post({ userId: accountId, action: "archive_request", reasonCode: "other", reasonNote: "Fora da fila por enquanto" }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.action).toBe("archive_request");
    expect(admin.rpc).toHaveBeenNthCalledWith(1, "master_archive_access_request", expect.objectContaining({
      p_actor_id: actorId,
      p_target_user_id: accountId,
      p_reason_code: "other",
      p_reason_note: "Solicitação confirmada arquivada: Fora da fila por enquanto",
    }));
    expect(admin.auth.admin.updateUserById).toHaveBeenCalledWith(accountId, { ban_duration: "876000h" });
    expect(admin.rpc).toHaveBeenNthCalledWith(2, "master_finish_admin_audit", expect.objectContaining({
      p_audit_id: "audit-archive",
      p_outcome: "completed",
    }));
  });

  it("reabre um pedido arquivado mantendo a conta pendente e auditando a ação", async () => {
    admin.rpc
      .mockResolvedValueOnce({ data: { auditId: "audit-reopen", authAction: "unban", retry: false }, error: null })
      .mockResolvedValueOnce({ data: true, error: null });
    admin.auth.admin.updateUserById.mockResolvedValue({ data: { user: { id: accountId } }, error: null });

    const response = await POST(post({ userId: accountId, action: "reopen_request", reasonCode: "user_requested" }));

    expect(response.status).toBe(200);
    expect(admin.rpc).toHaveBeenNthCalledWith(1, "master_reopen_access_request", expect.objectContaining({
      p_target_user_id: accountId,
      p_reason_note: "Solicitação arquivada reaberta: devolvida à fila para nova análise.",
    }));
    expect(admin.auth.admin.updateUserById).toHaveBeenCalledWith(accountId, { ban_duration: "none" });
  });

  it("não executa exclusão Auth se o banco disser que a conta não está na lixeira", async () => {
    admin.rpc.mockResolvedValueOnce({ data: null, error: { message: "account must be in trash before permanent deletion" } });

    const response = await POST(post({ userId: accountId, action: "delete_permanently", reasonCode: "user_requested", reauthPassword: "fake-master-password" }));
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toMatch(/lixeira/);
    expect(admin.auth.admin.deleteUser).not.toHaveBeenCalled();
  });

  it("registra início e conclusão da exclusão após validação transacional do banco", async () => {
    admin.rpc
      .mockResolvedValueOnce({ data: { auditId: "audit-1", authAction: "delete", retry: false }, error: null })
      .mockResolvedValueOnce({ data: true, error: null });
    admin.auth.admin.deleteUser.mockResolvedValue({ data: { user: { id: accountId } }, error: null });

    const response = await POST(post({ userId: accountId, action: "delete_permanently", reasonCode: "user_requested", reauthPassword: "fake-master-password" }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(admin.auth.admin.deleteUser).toHaveBeenCalledWith(accountId);
    expect(verifyMasterPassword).toHaveBeenCalledWith(actorId, "master@example.invalid", "fake-master-password");
    expect(admin.rpc).toHaveBeenNthCalledWith(1, "master_transition_account", expect.objectContaining({
      p_actor_id: actorId,
      p_target_user_id: accountId,
      p_action: "delete_permanently",
      p_reason_code: "user_requested",
    }));
    expect(admin.rpc).toHaveBeenNthCalledWith(2, "master_finish_admin_audit", expect.objectContaining({
      p_actor_id: actorId,
      p_audit_id: "audit-1",
      p_outcome: "completed",
    }));
  });

  it("registra falha do serviço Auth sem apagar o resultado do fluxo", async () => {
    admin.rpc
      .mockResolvedValueOnce({ data: { auditId: "audit-2", authAction: "delete", retry: false }, error: null })
      .mockResolvedValueOnce({ data: true, error: null });
    admin.auth.admin.deleteUser.mockResolvedValue({ data: null, error: { message: "temporary auth error" } });

    const response = await POST(post({ userId: accountId, action: "delete_permanently", reasonCode: "user_requested", reauthPassword: "fake-master-password" }));

    expect(response.status).toBe(503);
    expect(admin.rpc).toHaveBeenNthCalledWith(2, "master_finish_admin_audit", expect.objectContaining({
      p_audit_id: "audit-2",
      p_outcome: "failed",
      p_detail_code: "auth_delete_failed",
    }));
  });

  it("marca a auditoria para reconciliação quando não consegue confirmar o resultado após a alteração de Auth", async () => {
    admin.rpc
      .mockResolvedValueOnce({ data: { auditId: "audit-needs-attention", authAction: "ban", retry: false }, error: null })
      .mockResolvedValueOnce({ data: null, error: { message: "temporary database response failure" } })
      .mockResolvedValueOnce({ data: true, error: null });
    admin.auth.admin.updateUserById.mockResolvedValue({ data: { user: { id: accountId } }, error: null });

    const response = await POST(post({ userId: accountId, action: "disable", reasonCode: "policy_violation" }));

    expect(response.status).toBe(503);
    expect((await response.json()).error).toMatch(/reconciliação/i);
    expect(admin.rpc).toHaveBeenNthCalledWith(3, "master_finish_admin_audit", expect.objectContaining({
      p_actor_id: actorId,
      p_audit_id: "audit-needs-attention",
      p_outcome: "needs_attention",
      p_detail_code: "audit_reconciliation_required",
    }));
  });

  it("rejeita exclusão definitiva sem reautenticação", async () => {
    const response = await POST(post({ userId: accountId, action: "delete_permanently", reasonCode: "user_requested" }));

    expect(response.status).toBe(400);
    expect(verifyMasterPassword).not.toHaveBeenCalled();
    expect(admin.rpc).not.toHaveBeenCalled();
  });

  it("não inicia exclusão quando a senha Master está incorreta", async () => {
    verifyMasterPassword.mockResolvedValueOnce({ valid: false, unavailable: false });
    const response = await POST(post({ userId: accountId, action: "delete_permanently", reasonCode: "user_requested", reauthPassword: "incorrect-fake-password" }));

    expect(response.status).toBe(401);
    expect(admin.rpc).not.toHaveBeenCalled();
    expect(admin.auth.admin.deleteUser).not.toHaveBeenCalled();
  });

  it("marca reconciliação se não consegue confirmar a auditoria da exclusão", async () => {
    admin.rpc
      .mockResolvedValueOnce({ data: { auditId: "audit-3", authAction: "delete", retry: false }, error: null })
      .mockResolvedValueOnce({ data: false, error: null })
      .mockResolvedValueOnce({ data: false, error: null });
    admin.auth.admin.deleteUser.mockResolvedValue({ data: { user: { id: accountId } }, error: null });

    const response = await POST(post({ userId: accountId, action: "delete_permanently", reasonCode: "user_requested", reauthPassword: "fake-master-password" }));

    expect(response.status).toBe(503);
    expect((await response.json()).error).toMatch(/histórico não confirmou/i);
    expect(admin.rpc).toHaveBeenNthCalledWith(3, "master_finish_admin_audit", expect.objectContaining({
      p_audit_id: "audit-3",
      p_outcome: "needs_attention",
      p_detail_code: "audit_reconciliation_required",
    }));
  });

  it("finaliza com segurança uma repetição quando o usuário Auth já foi removido", async () => {
    admin.rpc
      .mockResolvedValueOnce({ data: { auditId: "audit-retry", authAction: "delete", retry: true, alreadyDeleted: true }, error: null })
      .mockResolvedValueOnce({ data: true, error: null });
    admin.auth.admin.getUserById.mockResolvedValue({
      data: { user: null },
      error: { message: "User not found", status: 404, code: "user_not_found" },
    });

    const response = await POST(post({ userId: accountId, action: "delete_permanently", reasonCode: "user_requested", reauthPassword: "fake-master-password" }));

    expect(response.status).toBe(200);
    expect(admin.auth.admin.deleteUser).not.toHaveBeenCalled();
    expect(admin.rpc).toHaveBeenNthCalledWith(2, "master_finish_admin_audit", expect.objectContaining({ p_outcome: "completed" }));
  });
});
