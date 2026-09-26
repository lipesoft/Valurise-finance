import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { admin, resend } = vi.hoisted(() => ({
  admin: { rpc: vi.fn(async (): Promise<{ data: boolean; error: { message: string } | null }> => ({ data: true, error: null })) },
  resend: vi.fn(async (): Promise<{ data: Record<string, never>; error: { message: string } | null }> => ({ data: {}, error: null })),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({ auth: { resend } })),
}));
vi.mock("@/lib/supabase/admin", () => ({ getSupabaseAdminClient: () => admin }));

import { POST } from "./route";

function request(email = "Pessoa@Example.invalid", origin = "http://localhost") {
  return new NextRequest("http://localhost/api/auth/resend-confirmation", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ email }),
  });
}

describe("POST /api/auth/resend-confirmation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "fake-publishable-key");
    admin.rpc.mockResolvedValue({ data: true, error: null });
    resend.mockResolvedValue({ data: {}, error: null });
  });

  afterEach(() => vi.unstubAllEnvs());

  it("reenvia confirmação usando endereço normalizado e redirect da própria origem", async () => {
    const response = await POST(request());

    expect(response.status).toBe(202);
    expect(resend).toHaveBeenCalledWith({
      type: "signup",
      email: "pessoa@example.invalid",
      options: { emailRedirectTo: "http://localhost" },
    });
    expect(admin.rpc).toHaveBeenCalledTimes(2);
  });

  it("não revela se o e-mail existe, está confirmado ou se o provedor não o reenviou", async () => {
    const success = await POST(request());
    resend.mockResolvedValueOnce({ data: {}, error: { message: "User not found" } });
    const providerDeclined = await POST(request("nao-existe@example.invalid"));

    expect(await success.json()).toEqual({ ok: true });
    expect(await providerDeclined.json()).toEqual({ ok: true });
    expect(providerDeclined.status).toBe(success.status);
  });

  it("aplica limite antes de chamar o provedor", async () => {
    admin.rpc.mockResolvedValueOnce({ data: false, error: null });

    const response = await POST(request());

    expect(response.status).toBe(429);
    expect(resend).not.toHaveBeenCalled();
  });

  it("rejeita uma origem diferente da aplicação", async () => {
    const response = await POST(request("pessoa@example.invalid", "https://attacker.invalid"));

    expect(response.status).toBe(403);
    expect(resend).not.toHaveBeenCalled();
  });
});
