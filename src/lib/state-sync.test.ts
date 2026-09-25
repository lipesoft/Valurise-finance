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

    await expect(loadValuriseState("workspace-1")).resolves.toEqual({ state, version: 7 });
    expect(select).toHaveBeenCalledWith("state, version");
    expect(eq).toHaveBeenCalledWith("workspace_id", "workspace-1");
  });

  it("atualiza somente se a versão esperada ainda for a atual", async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: { version: 8 }, error: null });
    const select = vi.fn().mockReturnValue({ maybeSingle });
    const eqVersion = vi.fn().mockReturnValue({ select });
    const eqUser = vi.fn().mockReturnValue({ eq: eqVersion });
    const update = vi.fn().mockReturnValue({ eq: eqUser });
    mocks.client.from.mockReturnValue({ update });

    await expect(saveValuriseState(state, { id: "workspace-1", type: "personal" }, 7)).resolves.toEqual({ synced: true, version: 8 });
    expect(eqUser).toHaveBeenCalledWith("workspace_id", "workspace-1");
    expect(eqVersion).toHaveBeenCalledWith("version", 7);
  });

  it("sinaliza conflito em vez de sobrescrever uma alteração de outro dispositivo", async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    const select = vi.fn().mockReturnValue({ maybeSingle });
    const eqVersion = vi.fn().mockReturnValue({ select });
    const eqUser = vi.fn().mockReturnValue({ eq: eqVersion });
    const update = vi.fn().mockReturnValue({ eq: eqUser });
    mocks.client.from.mockReturnValue({ update });

    await expect(saveValuriseState(state, { id: "workspace-1", type: "business" }, 7)).resolves.toEqual({ synced: false, reason: "conflict" });
  });

  it("cria o primeiro documento pessoal preservando a atribuição legada", async () => {
    const insert = vi.fn().mockResolvedValue({ error: null });
    mocks.client.from.mockReturnValue({ insert });

    await expect(saveValuriseState(state, { id: "personal-1", type: "personal" })).resolves.toEqual({ synced: true, version: 1 });
    expect(insert).toHaveBeenCalledWith({ workspace_id: "personal-1", user_id: "user-1", state, version: 1 });
  });

  it("cria o estado empresarial sem atribuí-lo à conta pessoal do proprietário", async () => {
    const insert = vi.fn().mockResolvedValue({ error: null });
    mocks.client.from.mockReturnValue({ insert });

    await expect(saveValuriseState(state, { id: "business-1", type: "business" })).resolves.toEqual({ synced: true, version: 1 });
    expect(insert).toHaveBeenCalledWith({ workspace_id: "business-1", user_id: null, state, version: 1 });
  });
});
