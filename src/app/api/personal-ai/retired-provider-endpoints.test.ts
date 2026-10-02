import { beforeEach, describe, expect, it, vi } from "vitest";

const getWorkspaceContext = vi.hoisted(() => vi.fn());

vi.mock("@/lib/workspaces/server", () => ({ getVerifiedWorkspaceContext: getWorkspaceContext }));

import { NextRequest } from "next/server";
import { POST as discoverModels } from "./models/route";
import { POST as testProvider } from "./test/route";

const retiredRoutes = [
  ["catálogo pessoal", discoverModels],
  ["teste individual de provider", testProvider],
] as const;

describe.each(retiredRoutes)("endpoint legado de %s", (_name, post) => {
  beforeEach(() => {
    vi.clearAllMocks();
    getWorkspaceContext.mockResolvedValue({
      ok: true,
      user: { id: "11111111-1111-4111-8111-111111111111" },
      workspace: { id: "22222222-2222-4222-8222-222222222222", type: "personal", displayName: "Pessoal", role: "owner" },
    });
  });

  it("recusa configurações/chamadas individuais sem refletir a chave recebida", async () => {
    const response = await post(new NextRequest("http://localhost/api/personal-ai/retired", {
      method: "POST",
      headers: {
        authorization: "Bearer test-session-token",
        "x-valurise-workspace-id": "22222222-2222-4222-8222-222222222222",
        "content-type": "application/json",
      },
      body: JSON.stringify({ provider: "openrouter", model: "paid-model", apiKey: "secret-not-to-reflect" }),
    }));

    expect(response.status).toBe(410);
    const body = await response.json();
    expect(body.error).toMatch(/centralmente|Super Admin/);
    expect(JSON.stringify(body)).not.toContain("secret-not-to-reflect");
  });

  it("exige sessão válida antes de responder que a rota foi encerrada", async () => {
    getWorkspaceContext.mockResolvedValue({ ok: false, status: 401, error: "Sessão inválida." });

    const response = await post(new NextRequest("http://localhost/api/personal-ai/retired", { method: "POST" }));

    expect(response.status).toBe(401);
  });
});
