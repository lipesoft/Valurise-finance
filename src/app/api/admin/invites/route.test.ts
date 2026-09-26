import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { admin, getVerifiedMaster } = vi.hoisted(() => ({
  admin: { rpc: vi.fn() },
  getVerifiedMaster: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  getSupabaseAdminClient: () => admin,
  getVerifiedMaster,
}));

import { GET } from "./route";

const actorId = "00000000-0000-4000-8000-000000000001";

describe("GET /api/admin/invites", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getVerifiedMaster.mockResolvedValue({ id: actorId, email: "master@example.invalid" });
  });

  it("retorna o link só para convites ativos e não expõe tokens inativos", async () => {
    admin.rpc.mockResolvedValueOnce({
      data: {
        items: [
          { id: "invite-active", token: "fake-active-token", status: "active" },
          { id: "invite-used", token: "fake-used-token", status: "used" },
          { id: "invite-revoked", token: "fake-revoked-token", status: "revoked" },
        ],
        total: 3,
        page: 1,
        pageSize: 25,
      },
      error: null,
    });

    const response = await GET(new NextRequest("https://valurise.example/api/admin/invites?page=1", {
      headers: { Authorization: "Bearer fake-token" },
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.items[0]).toMatchObject({ id: "invite-active", link: "https://valurise.example/?invite=fake-active-token" });
    expect(body.items[0]).not.toHaveProperty("token");
    expect(body.items[1]).toMatchObject({ id: "invite-used", link: "" });
    expect(body.items[1]).not.toHaveProperty("token");
    expect(body.items[2]).toMatchObject({ id: "invite-revoked", link: "" });
    expect(body.items[2]).not.toHaveProperty("token");
  });

  it("não lista convites sem autorização Master", async () => {
    getVerifiedMaster.mockResolvedValueOnce(null);

    const response = await GET(new NextRequest("https://valurise.example/api/admin/invites"));

    expect(response.status).toBe(403);
    expect(admin.rpc).not.toHaveBeenCalled();
  });
});
