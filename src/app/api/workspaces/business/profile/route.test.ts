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

const companyProfile = {
  email: "contato@empresa.invalid",
  phone: "11999990000",
  postal_code: "01001000",
  street: "Rua de teste",
  number: "10",
  address_complement: "",
  neighborhood: "Centro",
  city: "São Paulo",
  state: "SP",
  activity_start_date: "2020-02-29",
  cnae: "6201500",
  tax_regime: "simples_nacional",
  accountant_name: "Contador QA",
  management_close_day: 31,
  default_currency: "BRL",
  timezone: "America/Sao_Paulo",
};

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

  it("não confirma como salvo o perfil empresarial quando a atualização não atinge nenhuma linha", async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    const select = vi.fn().mockReturnValue({ maybeSingle });
    const eq = vi.fn().mockReturnValue({ select });
    const update = vi.fn().mockReturnValue({ eq });
    const from = vi.fn().mockReturnValue({ update });
    mocks.createScopedClient.mockReturnValue({ from });

    const response = await PATCH(request("PATCH", { section: "company", profile: companyProfile }));
    const result = await response.json();

    expect(response.status).toBe(404);
    expect(result.error).toContain("Não foi possível confirmar a atualização");
    expect(update).toHaveBeenCalledOnce();
    expect(eq).toHaveBeenCalledWith("workspace_id", businessId);
    expect(select).toHaveBeenCalledWith("workspace_id");
  });

  it("confirma atualização cadastral somente depois de receber a linha atualizada", async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: { workspace_id: businessId }, error: null });
    const select = vi.fn().mockReturnValue({ maybeSingle });
    const eq = vi.fn().mockReturnValue({ select });
    const update = vi.fn().mockReturnValue({ eq });
    const from = vi.fn().mockReturnValue({ update });
    mocks.createScopedClient.mockReturnValue({ from });

    const response = await PATCH(request("PATCH", { section: "company", profile: companyProfile }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(select).toHaveBeenCalledWith("workspace_id");
  });
});
