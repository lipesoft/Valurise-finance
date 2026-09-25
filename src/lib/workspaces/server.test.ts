import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: { id: "user-1" } as { id: string } | null,
  selectedWorkspaceId: "11111111-1111-4111-8111-111111111111",
  membershipWorkspaceId: "11111111-1111-4111-8111-111111111111",
  membership: { role: "owner", status: "active" },
  workspace: { id: "11111111-1111-4111-8111-111111111111", type: "personal", display_name: "Pessoal", archived_at: null },
  admin: { from: vi.fn() },
  getVerifiedActiveUser: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({
  getSupabaseAdminClient: () => mocks.admin,
  getVerifiedActiveUser: (...args: unknown[]) => mocks.getVerifiedActiveUser(...args),
}));

import { getVerifiedWorkspaceContext } from "./server";

function setupQueries() {
  mocks.admin.from.mockImplementation((table: string) => {
    let requestedId = "";
    const query: Record<string, any> = {};
    query.select = vi.fn(() => query);
    query.eq = vi.fn((column: string, value: string) => { if (column === "workspace_id" || column === "id") requestedId = value; return query; });
    query.is = vi.fn(() => query);
    query.maybeSingle = vi.fn(async () => ({ data: table === "user_active_workspaces"
      ? { workspace_id: mocks.selectedWorkspaceId }
      : table === "workspace_memberships"
        ? requestedId === mocks.membershipWorkspaceId ? mocks.membership : null
        : table === "workspaces"
          ? requestedId === mocks.workspace.id ? mocks.workspace : null
          : null, error: null }));
    query.upsert = vi.fn(async () => ({ error: null }));
    return query;
  });
}

describe("resolução segura do workspace solicitado", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.user = { id: "user-1" };
    mocks.selectedWorkspaceId = "11111111-1111-4111-8111-111111111111";
    mocks.membershipWorkspaceId = "11111111-1111-4111-8111-111111111111";
    mocks.membership = { role: "owner", status: "active" };
    mocks.workspace = { id: "11111111-1111-4111-8111-111111111111", type: "personal", display_name: "Pessoal", archived_at: null };
    mocks.getVerifiedActiveUser.mockImplementation(async () => mocks.user);
    setupQueries();
  });

  it("resolve o workspace do pedido após validar membership ativa", async () => {
    await expect(getVerifiedWorkspaceContext("Bearer valid", "11111111-1111-4111-8111-111111111111")).resolves.toMatchObject({
      ok: true,
      user: { id: "user-1" },
      workspace: { id: "11111111-1111-4111-8111-111111111111", type: "personal", role: "owner" },
    });
    expect(mocks.admin.from).toHaveBeenCalledWith("workspace_memberships");
    expect(mocks.admin.from).toHaveBeenCalledWith("workspaces");
  });

  it("usa a preferência salva somente quando a chamada não informa contexto", async () => {
    await expect(getVerifiedWorkspaceContext("Bearer valid")).resolves.toMatchObject({
      ok: true,
      workspace: { id: "11111111-1111-4111-8111-111111111111", type: "personal" },
    });
    expect(mocks.admin.from).toHaveBeenCalledWith("user_active_workspaces");
  });

  it("rejeita IDs malformados antes de consultar o banco", async () => {
    await expect(getVerifiedWorkspaceContext("Bearer valid", "not-a-uuid")).resolves.toMatchObject({
      ok: false,
      status: 403,
    });
    expect(mocks.admin.from).not.toHaveBeenCalled();
  });

  it("rejeita workspace sem membership mesmo que venha na requisição", async () => {
    await expect(getVerifiedWorkspaceContext("Bearer valid", "22222222-2222-4222-8222-222222222222")).resolves.toMatchObject({
      ok: false,
      status: 403,
    });
    expect(mocks.admin.from).toHaveBeenCalledTimes(2);
  });

  it("permite uma sessão continuar no workspace próprio enquanto outro dispositivo muda a preferência global", async () => {
    mocks.selectedWorkspaceId = "33333333-3333-4333-8333-333333333333";
    await expect(getVerifiedWorkspaceContext("Bearer valid", "11111111-1111-4111-8111-111111111111")).resolves.toMatchObject({
      ok: true,
      workspace: { id: "11111111-1111-4111-8111-111111111111", type: "personal" },
    });
  });

  it("nega contexto sem membership ativa", async () => {
    mocks.membership = { role: "owner", status: "removed" };
    await expect(getVerifiedWorkspaceContext("Bearer valid", "11111111-1111-4111-8111-111111111111")).resolves.toMatchObject({
      ok: false,
      status: 403,
    });
  });

  it("não consulta workspaces para uma sessão inválida", async () => {
    mocks.user = null;
    await expect(getVerifiedWorkspaceContext(null)).resolves.toMatchObject({ ok: false, status: 401 });
    expect(mocks.admin.from).not.toHaveBeenCalled();
  });
});
