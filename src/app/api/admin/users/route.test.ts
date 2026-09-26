import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { admin, getVerifiedMaster } = vi.hoisted(() => {
  const rpc = vi.fn();
  const deleteUser = vi.fn();
  const updateUserById = vi.fn();
  return {
    admin: { rpc, auth: { admin: { deleteUser, updateUserById } } },
    getVerifiedMaster: vi.fn(),
  };
});

vi.mock("@/lib/supabase/admin", () => ({
  getSupabaseAdminClient: () => admin,
  getVerifiedMaster,
}));

import { POST } from "./route";

const actorId = "00000000-0000-4000-8000-000000000001";
const accountId = "00000000-0000-4000-8000-000000000002";

function post(body: unknown) {
  return new NextRequest("http://localhost/api/admin/users", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer fake-token" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/admin/users", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getVerifiedMaster.mockResolvedValue({ id: actorId });
  });

  it("exige motivo antes de iniciar ações sensíveis", async () => {
    const response = await POST(post({ userId: accountId, action: "delete_permanently" }));

    expect(response.status).toBe(400);
    expect(admin.rpc).not.toHaveBeenCalled();
    expect(admin.auth.admin.deleteUser).not.toHaveBeenCalled();
  });

  it("não executa exclusão Auth se o banco disser que a conta não está na lixeira", async () => {
    admin.rpc.mockResolvedValueOnce({ data: null, error: { message: "account must be in trash before permanent deletion" } });

    const response = await POST(post({ userId: accountId, action: "delete_permanently", reasonCode: "user_requested" }));
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

    const response = await POST(post({ userId: accountId, action: "delete_permanently", reasonCode: "user_requested" }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(admin.auth.admin.deleteUser).toHaveBeenCalledWith(accountId);
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

    const response = await POST(post({ userId: accountId, action: "delete_permanently", reasonCode: "other" }));

    expect(response.status).toBe(503);
    expect(admin.rpc).toHaveBeenNthCalledWith(2, "master_finish_admin_audit", expect.objectContaining({
      p_audit_id: "audit-2",
      p_outcome: "failed",
      p_detail_code: "auth_delete_failed",
    }));
  });
});
