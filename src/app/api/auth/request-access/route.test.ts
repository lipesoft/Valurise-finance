import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createHash } from "node:crypto";

const { admin, createUser, deleteUser, tables } = vi.hoisted(() => {
  const makeTable = () => {
    const table = {
      error: null as null,
      select: vi.fn(),
      eq: vi.fn(),
      ilike: vi.fn(),
      is: vi.fn(),
      gt: vi.fn(),
      maybeSingle: vi.fn(),
      insert: vi.fn(),
      update: vi.fn(),
      upsert: vi.fn(),
    };
    table.select.mockReturnValue(table);
    table.eq.mockReturnValue(table);
    table.ilike.mockReturnValue(table);
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
  const createUser = vi.fn();
  const deleteUser = vi.fn();
  const admin = {
    rpc: vi.fn(async () => ({ data: true, error: null })),
    from: vi.fn((name: keyof typeof tables) => tables[name]),
    auth: { admin: { createUser, deleteUser } },
  };
  return { admin, createUser, deleteUser, tables };
});

vi.mock("@/lib/supabase/admin", () => ({ getSupabaseAdminClient: () => admin }));

import { POST } from "./route";

const userId = "00000000-0000-4000-8000-000000000002";
const rateLimitKey = (scope: string, value: string) => createHash("sha256").update(`${scope}\0${value}`).digest("hex");

function request(overrides: Record<string, unknown> = {}) {
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
      ...overrides,
    }),
  });
}

describe("POST /api/auth/request-access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    admin.rpc.mockResolvedValue({ data: true, error: null });
    tables.profiles.maybeSingle.mockResolvedValue({ data: null, error: null });
    tables.access_request_details.insert.mockResolvedValue({ error: null });
    tables.access_request_details.update.mockReturnValue(tables.access_request_details);
    tables.access_request_details.eq.mockReturnValue(tables.access_request_details);
    tables.user_consents.upsert.mockResolvedValue({ error: null });
    deleteUser.mockResolvedValue({ error: null });
    createUser.mockResolvedValue({
      data: { user: { id: userId, email_confirmed_at: null } },
      error: null,
    });
  });

  afterEach(() => vi.unstubAllEnvs());

  it("cria a conta bloqueada e envia o pedido direto para a fila do Master, sem e-mail de confirmação", async () => {
    const response = await POST(request());

    expect(response.status).toBe(202);
    expect(createUser).toHaveBeenCalledWith(expect.objectContaining({
      email: "pessoa@example.invalid",
      email_confirm: false,
      ban_duration: "876000h",
      user_metadata: { full_name: "Pessoa de Teste", username: "pessoa.teste" },
    }));
    expect(tables.access_request_details.insert).toHaveBeenCalledWith({
      user_id: userId,
      invite_id: null,
      request_status: "pending_review",
    });
    expect(tables.access_request_details.update).not.toHaveBeenCalled();
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it("permite nomes de exibição iguais quando usuário e e-mail são distintos", async () => {
    const response = await POST(request({ username: "pessoa.teste2", email: "outra@example.invalid" }));

    expect(response.status).toBe(202);
    expect(createUser).toHaveBeenCalledWith(expect.objectContaining({
      email: "outra@example.invalid",
      email_confirm: false,
      ban_duration: "876000h",
      user_metadata: { full_name: "Pessoa de Teste", username: "pessoa.teste2" },
    }));
    expect(tables.access_request_details.insert).toHaveBeenCalledWith(expect.objectContaining({ request_status: "pending_review" }));
  });

  it("explica que o usuário precisa ser trocado sem criar conta nem solicitação para o Master", async () => {
    tables.profiles.maybeSingle.mockResolvedValueOnce({ data: { id: userId }, error: null });

    const response = await POST(request({ username: "Pessoa.Teste" }));
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload.error).toMatch(/Confira o usuário escolhido/i);
    expect(tables.profiles.ilike).toHaveBeenCalledWith("username", "pessoa.teste");
    expect(createUser).not.toHaveBeenCalled();
    expect(tables.access_request_details.insert).not.toHaveBeenCalled();
    expect(JSON.stringify(payload)).not.toContain("Pessoa@Example.invalid");
  });

  it("impede e-mail já cadastrado antes de criar uma solicitação para o Master", async () => {
    createUser.mockResolvedValueOnce({ data: { user: null }, error: { code: "email_exists", message: "User already registered" } });

    const response = await POST(request());

    expect(response.status).toBe(202);
    expect(tables.access_request_details.insert).not.toHaveBeenCalled();
    expect(tables.user_consents.upsert).not.toHaveBeenCalled();
  });

  it("não expõe erro técnico do provedor quando não consegue criar a conta", async () => {
    createUser.mockResolvedValueOnce({ data: { user: null }, error: { code: "provider_error", message: "secret provider detail" } });

    const response = await POST(request());
    const payload = await response.json();

    expect(response.status).toBe(503);
    expect(payload.error).toMatch(/registrar sua solicitação/i);
    expect(JSON.stringify(payload)).not.toContain("secret provider detail");
    expect(tables.access_request_details.insert).not.toHaveBeenCalled();
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it("remove a conta bloqueada se não conseguir registrar o pedido para o Master", async () => {
    tables.access_request_details.insert.mockResolvedValueOnce({ error: { message: "insert failed" } });

    const response = await POST(request());

    expect(response.status).toBe(500);
    expect(deleteUser).toHaveBeenCalledWith(userId);
    expect(tables.user_consents.upsert).not.toHaveBeenCalled();
  });

  it("aplica um limite por IP que permite a rodada normal de testes sem liberar tentativas ilimitadas", async () => {
    const response = await POST(request());

    expect(response.status).toBe(202);
    expect(admin.rpc).toHaveBeenNthCalledWith(1, "consume_public_rate_limit", expect.objectContaining({
      p_key: rateLimitKey("access-request:v2:ip", "unknown"),
      p_max_attempts: 20,
      p_window_seconds: 3600,
    }));
  });

  it("não chama o provedor quando o limite por IP é atingido e não registra dados pessoais", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    admin.rpc.mockResolvedValueOnce({ data: false, error: null });

    const response = await POST(request());

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("3600");
    expect(createUser).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("[auth.request-access.rate-limited]", { scope: "ip" });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("Pessoa@Example.invalid");
    warn.mockRestore();
  });

  it("mantém limite específico por e-mail e não chama o provedor após excedê-lo", async () => {
    admin.rpc
      .mockResolvedValueOnce({ data: true, error: null })
      .mockResolvedValueOnce({ data: false, error: null });

    const response = await POST(request());

    expect(response.status).toBe(429);
    expect(createUser).not.toHaveBeenCalled();
    expect(admin.rpc).toHaveBeenNthCalledWith(2, "consume_public_rate_limit", expect.objectContaining({
      p_key: rateLimitKey("access-request:v2:email", "pessoa@example.invalid"),
      p_max_attempts: 8,
      p_window_seconds: 3600,
    }));
  });
});
