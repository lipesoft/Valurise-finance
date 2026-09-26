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

describe("GET /api/admin/audit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getVerifiedMaster.mockResolvedValue({ id: "00000000-0000-4000-8000-000000000001" });
    admin.rpc.mockResolvedValue({ data: { items: [], total: 0, page: 1, pageSize: 25 }, error: null });
  });

  it("valida o Master e repassa os filtros de auditoria com escopo restrito", async () => {
    const response = await GET(new NextRequest("http://localhost/api/admin/audit?page=2&action=disabled&outcome=failed&since=2026-09-01T03%3A00%3A00.000Z&until=2026-10-01T03%3A00%3A00.000Z", {
      headers: { Authorization: "Bearer fake-token" },
    }));

    expect(response.status).toBe(200);
    expect(admin.rpc).toHaveBeenCalledWith("master_list_audit_filtered", {
      p_actor_id: "00000000-0000-4000-8000-000000000001",
      p_page: 2,
      p_page_size: 25,
      p_action: "disabled",
      p_outcome: "failed",
      p_since: "2026-09-01T03:00:00.000Z",
      p_until: "2026-10-01T03:00:00.000Z",
    });
  });

  it("recusa intervalos e categorias de resultado inválidos antes de consultar o banco", async () => {
    const invalidRange = await GET(new NextRequest("http://localhost/api/admin/audit?since=2026-10-01T00%3A00%3A00.000Z&until=2026-09-01T00%3A00%3A00.000Z"));
    const invalidOutcome = await GET(new NextRequest("http://localhost/api/admin/audit?outcome=unknown"));

    expect(invalidRange.status).toBe(400);
    expect(invalidOutcome.status).toBe(400);
    expect(admin.rpc).not.toHaveBeenCalled();
  });

  it("nega usuários que não sejam Master", async () => {
    getVerifiedMaster.mockResolvedValueOnce(null);
    const response = await GET(new NextRequest("http://localhost/api/admin/audit"));

    expect(response.status).toBe(403);
    expect(admin.rpc).not.toHaveBeenCalled();
  });
});
