import { test, expect } from "./fixtures";

const masterId = "00000000-0000-4000-8000-000000000001";
const pendingId = "00000000-0000-4000-8000-000000000002";
const emailPendingId = "00000000-0000-4000-8000-000000000003";

function encode(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

async function signInAsMaster(page: import("@playwright/test").Page) {
  const now = Math.floor(Date.now() / 1000);
  const accessToken = encode({ alg: "none", typ: "JWT" }) + "." + encode({
    sub: masterId,
    aud: "authenticated",
    role: "authenticated",
    iat: now,
    exp: now + 3600,
  }) + "." + Buffer.from("e2e-signature").toString("base64url");
  const user = {
    id: masterId,
    aud: "authenticated",
    role: "authenticated",
    email: "master@valurise.invalid",
    app_metadata: { provider: "email", providers: ["email"] },
    email_confirmed_at: new Date().toISOString(),
    user_metadata: { full_name: "Master E2E" },
    identities: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  await page.route("**/api/auth/login", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ session: {
      access_token: accessToken,
      refresh_token: "e2e-refresh-token",
      token_type: "bearer",
      expires_in: 3600,
      expires_at: now + 3600,
      user,
    }, user }),
  }));
  await page.route("**/auth/v1/user**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(user) }));
  await page.route("**/rest/v1/profiles**", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ full_name: "Master E2E", account_status: "active", account_role: "master" }),
  }));

  await page.route("**/api/admin/users**", async (route) => {
    const method = route.request().method();
    if (method === "POST") {
      const body = route.request().postDataJSON() as { userId: string; action: string; reasonCode?: string };
      if (body.action === "approve" && body.userId === pendingId) {
        route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
        return;
      }
      route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "Ação inválida para este teste." }) });
      return;
    }
    const status = new URL(route.request().url()).searchParams.get("status");
    const pending = status === "pending" ? [{
      id: pendingId,
      email: "pedido@valurise.invalid",
      email_confirmed_at: new Date().toISOString(),
      last_sign_in_at: null,
      created_at: new Date().toISOString(),
      full_name: "Pedido Confirmado",
      username: "pedido.confirmado",
      role: "user",
      stored_status: "pending",
      request_status: "pending_review",
      requested_at: new Date().toISOString(),
      invite_id: null,
      invite_state: "none",
      status: "pending",
    }] : status === "pending_email" ? [{
      id: emailPendingId,
      email: "confirmar@valurise.invalid",
      email_confirmed_at: null,
      last_sign_in_at: null,
      created_at: new Date().toISOString(),
      full_name: "Aguardando E-mail",
      username: "aguardando.email",
      role: "user",
      stored_status: "pending",
      request_status: "pending_email",
      requested_at: new Date().toISOString(),
      invite_id: null,
      invite_state: "none",
      status: "pending_email",
    }] : [];
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items: pending, total: pending.length, page: 1, pageSize: 25, stats: { pending: 1, email_pending: 1, total: 2, active: 1, disabled: 0, trashed: 0, rejected: 0 } }),
    });
  });
  await page.route("**/api/admin/invites**", async (route) => {
    if (route.request().method() === "POST") {
      route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ invite: { id: "invite-new", token: "e2e-token", link: "http://127.0.0.1:3000/?invite=e2e-token" } }) });
      return;
    }
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [], total: 0, page: 1, pageSize: 25 }) });
  });
  await page.route("**/api/admin/audit**", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ items: [{ id: "audit-e2e", action: "approved", outcome: "completed", reason_code: null, reason_note: null, detail_code: null, created_at: new Date().toISOString(), actor_name: "Master E2E", actor_email: "master@valurise.invalid", target_name: "Pedido Confirmado", target_email: "pedido@valurise.invalid" }], total: 1, page: 1, pageSize: 25 }),
  }));

  await page.goto("/");
  const necessary = page.getByRole("button", { name: "Apenas necessários" });
  if (await necessary.isVisible().catch(() => false)) await necessary.click();
  await expect(page.locator('div[aria-hidden="false"] .login-shell')).toBeVisible();
  await page.getByLabel("Usuário ou e-mail").fill("master@valurise.invalid");
  await page.getByLabel("Senha", { exact: true }).fill("senha-ficticia-de-teste");
  await page.getByRole("button", { name: "Entrar na conta" }).click();
  await expect(page.getByRole("heading", { name: "Central do Master" })).toBeVisible();
}

test("painel Master mostra pedidos confirmados, mantém os outros em espera e oferece seções funcionais no mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signInAsMaster(page);

  await expect(page.getByText("Pedido Confirmado")).toBeVisible();
  await expect(page.getByRole("button", { name: "Aprovar" })).toBeVisible();
  await expect(page.getByText("Aguardando E-mail")).toBeVisible();
  await expect(page.getByText("Aguardando confirmação do e-mail")).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await page.getByRole("button", { name: "Aprovar" }).click();
  await expect(page.getByText("Acesso aprovado.")).toBeVisible();

  await page.getByRole("button", { name: "Usuários" }).click();
  await expect(page.getByLabel("Buscar por nome, usuário ou e-mail")).toBeVisible();
  await page.getByLabel("Buscar por nome, usuário ou e-mail").fill("inexistente");
  await expect(page.getByText("Nenhuma conta encontrada")).toBeVisible();

  await page.getByRole("button", { name: "Convites" }).click();
  await page.getByRole("button", { name: "Gerar convite" }).click();
  await expect(page.getByLabel("Link criado")).toHaveValue("http://127.0.0.1:3000/?invite=e2e-token");

  await page.getByRole("button", { name: "Auditoria" }).click();
  await expect(page.getByRole("article").getByText("Acesso aprovado", { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
