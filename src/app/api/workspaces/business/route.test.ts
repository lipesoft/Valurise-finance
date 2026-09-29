import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getWorkspaceContext: vi.fn(),
  adminClient: vi.fn(),
  company: { id: "22222222-2222-4222-8222-222222222222", type: "business", display_name: "Empresa QA", owner_user_id: "11111111-1111-4111-8111-111111111111" },
  personalWorkspace: { id: "33333333-3333-4333-8333-333333333333", type: "personal" },
  activeCollaborator: null as { user_id: string } | null,
  lookupError: null as { code: string } | null,
  selectionError: null as { code: string } | null,
  deleteError: null as { code: string } | null,
  deleteMatched: true,
  upsertCalls: [] as unknown[],
  deleteFilters: [] as Record<string, unknown>[],
}));

vi.mock("@/lib/workspaces/server", () => ({ getVerifiedWorkspaceContext: mocks.getWorkspaceContext }));
vi.mock("@/lib/supabase/admin", () => ({ getSupabaseAdminClient: mocks.adminClient, getVerifiedActiveUser: vi.fn() }));

import { NextRequest } from "next/server";
import { DELETE } from "./route";

const userId = "11111111-1111-4111-8111-111111111111";
const businessId = "22222222-2222-4222-8222-222222222222";
const personalId = "33333333-3333-4333-8333-333333333333";

function request(options: { workspaceId?: string; body?: unknown; origin?: string } = {}) {
  return new NextRequest("http://localhost/api/workspaces/business", {
    method: "DELETE",
    headers: {
      authorization: "Bearer test-session-token",
      "x-valurise-workspace-id": options.workspaceId || businessId,
      "content-type": "application/json",
      ...(options.origin ? { origin: options.origin } : {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

function createQuery(table: string) {
  const filters: Record<string, unknown> = {};
  let deleting = false;
  const query: Record<string, any> = {};
  query.select = vi.fn(() => query);
  query.eq = vi.fn((column: string, value: unknown) => { filters[column] = value; if (deleting) mocks.deleteFilters.push({ ...filters }); return query; });
  query.neq = vi.fn((column: string, value: unknown) => { filters[`not_${column}`] = value; return query; });
  query.is = vi.fn((column: string, value: unknown) => { filters[column] = value; return query; });
  query.order = vi.fn(() => query);
  query.limit = vi.fn(() => query);
  query.upsert = vi.fn(async (row: unknown) => { mocks.upsertCalls.push(row); return { error: mocks.selectionError }; });
  query.delete = vi.fn(() => { deleting = true; return query; });
  query.maybeSingle = vi.fn(async () => {
    if (table === "workspaces" && deleting) {
      if (mocks.deleteError) return { data: null, error: mocks.deleteError };
      const matches = filters.id === businessId && filters.owner_user_id === userId && filters.type === "business";
      return { data: matches && mocks.deleteMatched ? { id: businessId } : null, error: null };
    }
    if (table === "workspaces" && filters.type === "personal") return { data: mocks.personalWorkspace, error: mocks.lookupError };
    if (table === "workspaces" && filters.id === businessId) return { data: mocks.company, error: mocks.lookupError };
    if (table === "workspace_memberships") return { data: mocks.activeCollaborator, error: mocks.lookupError };
    return { data: null, error: mocks.lookupError };
  });
  return query;
}

describe("exclusão segura de workspace empresarial", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.company = { id: businessId, type: "business", display_name: "Empresa QA", owner_user_id: userId };
    mocks.personalWorkspace = { id: personalId, type: "personal" };
    mocks.activeCollaborator = null;
    mocks.lookupError = null;
    mocks.selectionError = null;
    mocks.deleteError = null;
    mocks.deleteMatched = true;
    mocks.upsertCalls = [];
    mocks.deleteFilters = [];
    mocks.getWorkspaceContext.mockResolvedValue({
      ok: true,
      user: { id: userId },
      workspace: { id: businessId, type: "business", displayName: "Empresa QA", role: "owner", userId },
    });
    mocks.adminClient.mockReturnValue({ from: vi.fn((table: string) => createQuery(table)) });
  });

  it("rejeita workspace pessoal antes de acessar o banco administrativo", async () => {
    mocks.getWorkspaceContext.mockResolvedValue({ ok: true, user: { id: userId }, workspace: { id: personalId, type: "personal", displayName: "Pessoal", role: "owner", userId } });
    const response = await DELETE(request({ workspaceId: personalId, body: { confirmationName: "Pessoal" } }));
    expect(response.status).toBe(403);
    expect(mocks.adminClient).not.toHaveBeenCalled();
  });

  it("não permite que um papel diferente de owner exclua a empresa", async () => {
    mocks.getWorkspaceContext.mockResolvedValue({ ok: true, user: { id: userId }, workspace: { id: businessId, type: "business", displayName: "Empresa QA", role: "admin", userId } });
    const response = await DELETE(request({ body: { confirmationName: "Empresa QA" } }));
    expect(response.status).toBe(403);
    expect(mocks.adminClient).not.toHaveBeenCalled();
  });

  it("exige nome exato antes de alterar a seleção ou remover dados", async () => {
    const response = await DELETE(request({ body: { confirmationName: "Empresa errada" } }));
    expect(response.status).toBe(400);
    expect(mocks.upsertCalls).toHaveLength(0);
    expect(mocks.deleteFilters).toHaveLength(0);
  });

  it("preserva empresas que ainda têm outras pessoas ativas", async () => {
    mocks.activeCollaborator = { user_id: "44444444-4444-4444-8444-444444444444" };
    const response = await DELETE(request({ body: { confirmationName: "Empresa QA" } }));
    expect(response.status).toBe(409);
    expect(mocks.upsertCalls).toHaveLength(0);
    expect(mocks.deleteFilters).toHaveLength(0);
  });

  it("apaga somente a empresa do proprietário e deixa o workspace Pessoal como padrão", async () => {
    const response = await DELETE(request({ body: { confirmationName: "empresa qa" } }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, deletedWorkspaceId: businessId, personalWorkspaceId: personalId });
    expect(mocks.upsertCalls).toEqual([{ user_id: userId, workspace_id: personalId, updated_at: expect.any(String) }]);
    expect(mocks.deleteFilters.at(-1)).toMatchObject({ id: businessId, owner_user_id: userId, type: "business" });
  });

  it("não remove a empresa se a seleção Pessoal não puder ser preparada", async () => {
    mocks.selectionError = { code: "DB_UNAVAILABLE" };
    const response = await DELETE(request({ body: { confirmationName: "Empresa QA" } }));
    expect(response.status).toBe(503);
    expect(mocks.deleteFilters).toHaveLength(0);
  });

  it("converte a proteção contra membro concorrente em conflito seguro", async () => {
    mocks.deleteError = { code: "23503" };
    const response = await DELETE(request({ body: { confirmationName: "Empresa QA" } }));
    expect(response.status).toBe(409);
    expect(mocks.deleteFilters.at(-1)).toMatchObject({ id: businessId, owner_user_id: userId, type: "business" });
  });

  it("bloqueia chamadas originadas em outro site", async () => {
    const response = await DELETE(request({ body: { confirmationName: "Empresa QA" }, origin: "https://example.invalid" }));
    expect(response.status).toBe(403);
    expect(mocks.getWorkspaceContext).not.toHaveBeenCalled();
  });
});
