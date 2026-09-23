import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  client: {
    auth: { getUser: vi.fn() },
    from: vi.fn(),
  },
}));

vi.mock("@/lib/supabase/client", () => ({
  getSupabaseBrowserClient: () => mocks.client,
}));

import { loadValuriseState, saveValuriseState } from "./state-sync";

const state = { data: { accounts: ["Nubank"] }, transactions: [], profile: { publicId: "VAL-TEST" } };

describe("synchronização financeira versionada", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.client.auth.getUser.mockResolvedValue({ data: { user: { id: "user-1" } }, error: null });
  });

  it("carrega o documento junto com sua versão", async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: { state, version: 7 }, error: null });
    const eq = vi.fn().mockReturnValue({ maybeSingle });
    const select = vi.fn().mockReturnValue({ eq });
    mocks.client.from.mockReturnValue({ select });

    await expect(loadValuriseState()).resolves.toEqual({ state, version: 7 });
    expect(select).toHaveBeenCalledWith("state, version");
  });

  it("atualiza somente se a versão esperada ainda for a atual", async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: { version: 8 }, error: null });
    const select = vi.fn().mockReturnValue({ maybeSingle });
    const eqVersion = vi.fn().mockReturnValue({ select });
    const eqUser = vi.fn().mockReturnValue({ eq: eqVersion });
    const update = vi.fn().mockReturnValue({ eq: eqUser });
    mocks.client.from.mockReturnValue({ update });

    await expect(saveValuriseState(state, 7)).resolves.toEqual({ synced: true, version: 8 });
    expect(eqUser).toHaveBeenCalledWith("user_id", "user-1");
    expect(eqVersion).toHaveBeenCalledWith("version", 7);
  });

  it("sinaliza conflito em vez de sobrescrever uma alteração de outro dispositivo", async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    const select = vi.fn().mockReturnValue({ maybeSingle });
    const eqVersion = vi.fn().mockReturnValue({ select });
    const eqUser = vi.fn().mockReturnValue({ eq: eqVersion });
    const update = vi.fn().mockReturnValue({ eq: eqUser });
    mocks.client.from.mockReturnValue({ update });

    await expect(saveValuriseState(state, 7)).resolves.toEqual({ synced: false, reason: "conflict" });
  });
});
