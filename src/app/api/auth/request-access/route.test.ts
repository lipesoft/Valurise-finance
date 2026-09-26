import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { admin, signUp, getUserById, deleteUser, updateUserById, tables } = vi.hoisted(() => {
  const makeTable = () => {
    const table = {
      error: null as null,
      select: vi.fn(),
      eq: vi.fn(),
      is: vi.fn(),
      gt: vi.fn(),
      maybeSingle: vi.fn(),
      insert: vi.fn(),
      update: vi.fn(),
      upsert: vi.fn(),
    };
    table.select.mockReturnValue(table);
    table.eq.mockReturnValue(table);
    table.is.mockReturnValue(table);
    table.gt.mockReturnValue(table);
    table.maybeSingle.mockResolvedValue({ data: null, error: null });
    table.insert.mockResolvedValue({ error: null });
    table.update.mockReturnValue(table);
    table.upsert.mockResolvedValue({ error: null });
    return table;
  };
  const tables = {
    profiles: makeTable(),
    access_request_details: makeTable(),
    user_consents: makeTable(),
    access_invites: makeTable(),
  };
  const signUp = vi.fn();
  const getUserById = vi.fn();
  const deleteUser = vi.fn();
  const updateUserById = vi.fn();
  const admin = {
    rpc: vi.fn(async () => ({ data: true, error: null })),
    from: vi.fn((name: keyof typeof tables) => tables[name]),
    auth: { admin: { getUserById, deleteUser, updateUserById } },
  };
  return { admin, signUp, getUserById, deleteUser, updateUserById, tables };
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({ auth: { signUp } })),
}));
vi.mock("@/lib/supabase/admin", () => ({ getSupabaseAdminClient: () => admin }));

import { POST } from "./route";

const userId = "00000000-0000-4000-8000-000000000002";

function request() {
  return new NextRequest("http://localhost/api/auth/request-access", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://localhost" },
    body: JSON.stringify({
      fullName: "Pessoa de Teste",
      username: "pessoa.teste",
      email: "Pessoa@Example.invalid",
      password: "senha-ficticia-e-segura",
      privacyAccepted: true,
      termsAccepted: true,
    }),
  });
}

describe("POST /api/auth/request-access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "fake-publishable-key");
    admin.rpc.mockResolvedValue({ data: true, error: null });
    tables.profiles.maybeSingle.mockResolvedValue({ data: null, error: null });
    tables.access_request_details.insert.mockResolvedValue({ error: null });
    tables.access_request_details.update.mockReturnValue(tables.access_request_details);
    tables.access_request_details.eq.mockReturnValue(tables.access_request_details);
    tables.user_consents.upsert.mockResolvedValue({ error: null });
    deleteUser.mockResolvedValue({ error: null });
    updateUserById.mockResolvedValue({ error: null });
    signUp.mockResolvedValue({
      data: { user: { id: userId, identities: [{ id: "identity" }], email_confirmed_at: null }, session: null },
      error: null,
    });
    getUserById.mockResolvedValue({ data: { user: { id: userId, email_confirmed_at: null } }, error: null });
  });

  afterEach(() => vi.unstubAllEnvs());

  it("cria o pedido como aguardando e-mail e não o libera para a fila do Master", async () => {
    const response = await POST(request());

    expect(response.status).toBe(202);
    expect(signUp).toHaveBeenCalledWith(expect.objectContaining({
      email: "pessoa@example.invalid",
      options: expect.objectContaining({ data: { full_name: "Pessoa de Teste", username: "pessoa.teste" } }),
    }));
    expect(tables.access_request_details.insert).toHaveBeenCalledWith({
      user_id: userId,
      invite_id: null,
      request_status: "pending_email",
    });
    expect(tables.access_request_details.update).not.toHaveBeenCalled();
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it("não cria uma solicitação quando o projeto aceita cadastro sem confirmação de e-mail", async () => {
    signUp.mockResolvedValueOnce({
      data: { user: { id: userId, identities: [{ id: "identity" }], email_confirmed_at: new Date().toISOString() }, session: { access_token: "fake-session" } },
      error: null,
    });

    const response = await POST(request());

    expect(response.status).toBe(503);
    expect((await response.json()).error).toMatch(/confirmação de e-mail não está ativa/i);
    expect(tables.access_request_details.insert).not.toHaveBeenCalled();
    expect(deleteUser).toHaveBeenCalledWith(userId);
  });

  it("fecha a corrida em que o e-mail é confirmado enquanto o registro é criado", async () => {
    getUserById.mockResolvedValueOnce({ data: { user: { id: userId, email_confirmed_at: new Date().toISOString() } }, error: null });

    const response = await POST(request());

    expect(response.status).toBe(202);
    expect(tables.access_request_details.update).toHaveBeenCalledWith({ request_status: "pending_review" });
    expect(tables.access_request_details.eq).toHaveBeenNthCalledWith(1, "user_id", userId);
    expect(tables.access_request_details.eq).toHaveBeenNthCalledWith(2, "request_status", "pending_email");
  });
});
