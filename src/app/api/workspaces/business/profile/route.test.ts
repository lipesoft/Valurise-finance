import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getWorkspaceContext: vi.fn(),
  createScopedClient: vi.fn(),
}));

vi.mock("@/lib/workspaces/server", () => ({ getVerifiedWorkspaceContext: mocks.getWorkspaceContext }));
vi.mock("@/lib/supabase/user-scoped", () => ({ createUserScopedSupabaseClient: mocks.createScopedClient }));

import { NextRequest } from "next/server";
import { GET, PATCH } from "./route";

const userId = "11111111-1111-4111-8111-111111111111";
const businessId = "22222222-2222-4222-8222-222222222222";

function request(method: "GET" | "PATCH", body?: unknown, workspaceId = businessId) {
  return new NextRequest("http://localhost/api/workspaces/business/profile?month=2025-04", {
    method,
    headers: { authorization: "Bearer test-session-token", "x-valurise-workspace-id": workspaceId, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("perfil financeiro empresarial com isolamento por workspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getWorkspaceContext.mockResolvedValue({ ok: true, user: { id: userId }, workspace: { id: businessId, type: "business", displayName: "Empresa QA", role: "owner", userId } });
  });

  it("não expõe perfil empresarial quando o workspace ativo é pessoal", async () => {
    mocks.getWorkspaceContext.mockResolvedValue({ ok: true, user: { id: userId }, workspace: { id: businessId, type: "personal", displayName: "Pessoal", role: "owner", userId } });
    const response = await GET(request("GET"));
    expect(response.status).toBe(403);
    expect(mocks.createScopedClient).not.toHaveBeenCalled();
  });

  it("impede edição por perfil somente de leitura antes de consultar o banco", async () => {
    mocks.getWorkspaceContext.mockResolvedValue({ ok: true, user: { id: userId }, workspace: { id: businessId, type: "business", displayName: "Empresa QA", role: "viewer", userId } });
    const response = await PATCH(request("PATCH", { section: "finance" }));
    expect(response.status).toBe(403);
    expect(mocks.createScopedClient).not.toHaveBeenCalled();
  });

  it("rejeita membership não validada sem ler dados", async () => {
    mocks.getWorkspaceContext.mockResolvedValue({ ok: false, status: 403, error: "Sem acesso." });
    const response = await GET(request("GET"));
    expect(response.status).toBe(403);
    expect(mocks.createScopedClient).not.toHaveBeenCalled();
  });

  it("rejeita períodos inválidos antes de consultar o Supabase", async () => {
    const response = await GET(new NextRequest("http://localhost/api/workspaces/business/profile?month=2025-13", { headers: { authorization: "Bearer test-session-token", "x-valurise-workspace-id": businessId } }));
    expect(response.status).toBe(400);
    expect(mocks.createScopedClient).not.toHaveBeenCalled();
  });
});
