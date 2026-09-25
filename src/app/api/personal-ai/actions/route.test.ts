import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getWorkspaceContext: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  getSupabaseAdminClient: () => ({ rpc: mocks.rpc }),
}));
vi.mock("@/lib/workspaces/server", () => ({
  getVerifiedWorkspaceContext: mocks.getWorkspaceContext,
}));

import { NextRequest } from "next/server";
import { legalVersions } from "@/lib/legal-content";
import { POST } from "./route";

const userId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const proposalId = "33333333-3333-4333-8333-333333333333";

function request() {
  return new NextRequest("http://localhost/api/personal-ai/actions", {
    method: "POST",
    headers: {
      authorization: "Bearer test-session-token",
      "x-valurise-workspace-id": workspaceId,
      "content-type": "application/json",
    },
    body: JSON.stringify({ proposalId, decision: "approve" }),
  });
}

describe("confirmação de propostas da Val por workspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getWorkspaceContext.mockResolvedValue({
      ok: true,
      user: { id: userId },
      workspace: { id: workspaceId, type: "personal", displayName: "Pessoal", role: "owner" },
    });
    mocks.rpc.mockResolvedValue({
      data: { ok: true, version: 2, transaction: { id: "transaction-1" } },
      error: null,
    });
  });

  it("usa o RPC workspace-aware e valida no servidor o consentimento esperado", async () => {
    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith("confirm_workspace_ai_transaction", {
      p_proposal_id: proposalId,
      p_user_id: userId,
      p_workspace_id: workspaceId,
      p_expected_consent_version: legalVersions.aiSharing,
    });
  });

  it("não tenta confirmar uma proposta para um usuário sem associação válida", async () => {
    mocks.getWorkspaceContext.mockResolvedValue({ ok: false, status: 403, error: "Sem acesso." });

    const response = await POST(request());

    expect(response.status).toBe(403);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
