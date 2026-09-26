import { test, expect } from "./fixtures";

async function dismissCookieNotice(page: import("@playwright/test").Page) {
  const necessary = page.getByRole("button", { name: "Apenas necessários" });
  await necessary.waitFor({ state: "visible", timeout: 5000 }).catch(() => undefined);
  if (await necessary.isVisible()) await necessary.click();
}

async function waitForApplicationReady(page: import("@playwright/test").Page) {
  await expect(page.locator('div[aria-hidden="false"] .login-shell')).toBeVisible();
}

test("aplica cabeçalhos básicos de segurança", async ({ page }) => {
  const response = await page.goto("/");
  expect(response?.headers()["x-content-type-options"]).toBe("nosniff");
  expect(response?.headers()["x-frame-options"]).toBe("DENY");
  expect(response?.headers()["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  expect(response?.headers()["permissions-policy"]).toContain("camera=()");
  expect(response?.headers()["strict-transport-security"]).toContain("max-age=31536000");
});

test("exibe acesso seguro e revela a senha sem sair da tela", async ({ page }) => {
  await page.goto("/");
  await dismissCookieNotice(page);

  await expect(page.getByRole("heading", { name: "VALURISE" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Acesse sua conta" })).toBeVisible();
  await expect(page.getByLabel("Usuário ou e-mail")).toBeVisible();
  await expect(page.getByLabel("Senha", { exact: true })).toHaveAttribute("type", "password");

  await page.getByLabel("Senha", { exact: true }).fill("senha-de-teste-nao-real");
  await page.getByRole("button", { name: "Mostrar senha" }).click();
  await expect(page.getByLabel("Senha", { exact: true })).toHaveAttribute("type", "text");
  await page.getByRole("button", { name: "Ocultar senha" }).click();
  await expect(page.getByLabel("Senha", { exact: true })).toHaveAttribute("type", "password");
});

test("não cria rolagem horizontal nos tamanhos mobile prioritários", async ({ page }) => {
  for (const width of [375, 390, 430]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Acesse sua conta" })).toBeVisible();

    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const card = await page.locator(".login-card").boundingBox();
    expect(card, `login card exists at ${width}px`).not.toBeNull();
    expect(card!.x, `login card starts within ${width}px`).toBeGreaterThanOrEqual(0);
    expect(card!.x + card!.width, `login card fits within ${width}px`).toBeLessThanOrEqual(width + 1);
    await expect.poll(() => page.getByLabel("Usuário ou e-mail").evaluate((input) => getComputedStyle(input).fontSize)).toBe("16px");
  }
});

test("valida campos no próprio formulário e anuncia erros acessivelmente", async ({ page }) => {
  let loginRequestSeen = false;
  await page.route("**/api/auth/login", (route) => {
    loginRequestSeen = true;
    return route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "Login ou senha inválidos." }) });
  });
  await page.goto("/");
  await dismissCookieNotice(page);
  await waitForApplicationReady(page);
  await page.getByRole("button", { name: "Entrar na conta" }).click();
  await expect(page.getByText("Confira os campos destacados.", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Usuário ou e-mail")).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByLabel("Senha", { exact: true })).toHaveAttribute("aria-invalid", "true");
  expect(loginRequestSeen).toBe(false);
  await page.getByLabel("Usuário ou e-mail").fill("usuario-invalido");
  await page.getByLabel("Senha", { exact: true }).fill("senha-ficticia");
  await page.getByRole("button", { name: "Entrar na conta" }).click();
  await expect.poll(() => loginRequestSeen).toBe(true);
});

test("orienta o próximo passo sem afirmar que toda tentativa virou pedido pendente", async ({ page }) => {
  await page.route("**/api/auth/request-access", (route) => route.fulfill({
    status: 202,
    contentType: "application/json",
    body: JSON.stringify({ ok: true }),
  }));
  await page.goto("/");
  await dismissCookieNotice(page);
  await waitForApplicationReady(page);
  await page.getByRole("button", { name: "Solicitar acesso" }).click();

  await page.getByLabel("Seu nome").fill("Pessoa de Teste");
  await page.getByLabel("Usuário").fill("teste.valurise");
  await page.getByLabel("E-mail").fill("teste@exemplo.invalid");
  await page.getByLabel("Senha", { exact: true }).fill("senha-e2e-ficticia");
  await page.getByLabel(/Política de Privacidade/).check();
  await page.getByLabel(/Termos de Uso/).check();
  await page.getByRole("button", { name: "Solicitar acesso", exact: true }).click();

  await expect(page.getByRole("heading", { name: "Próximo passo do seu acesso" })).toBeVisible();
  await expect(page.getByText(/Depois da confirmação, o pedido seguirá para análise do Master/)).toBeVisible();
  await expect(page.getByText(/Por segurança, não informamos qual situação se aplica/)).toBeVisible();
});

test("mostra a resposta segura ao pedir recuperação de senha", async ({ page }) => {
  await page.route("**/api/auth/password-reset", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true }),
  }));
  await page.goto("/");
  await dismissCookieNotice(page);
  await waitForApplicationReady(page);
  await page.getByRole("button", { name: "Esqueci minha senha" }).click();
  await page.getByLabel("E-mail").fill("teste@exemplo.invalid");
  await page.getByRole("button", { name: "Enviar link seguro" }).click();

  await expect(page.getByText("Se o e-mail estiver cadastrado, enviamos um link seguro para redefinir sua senha.")).toBeVisible();
});

test("limpa usuário e senha ao trocar do login para recuperação ou solicitação de acesso", async ({ page }) => {
  await page.goto("/");
  await dismissCookieNotice(page);
  await waitForApplicationReady(page);
  await page.getByLabel("Usuário ou e-mail").fill("filiperodrigues");
  await page.getByLabel("Senha", { exact: true }).fill("senha-ficticia-nao-real");

  await page.getByRole("button", { name: "Esqueci minha senha" }).click();
  await expect(page.getByLabel("E-mail")).toHaveValue("");
  await expect(page.getByLabel("Senha", { exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "Já tenho acesso" }).click();
  await page.getByLabel("Usuário ou e-mail").fill("filiperodrigues");
  await page.getByLabel("Senha", { exact: true }).fill("senha-ficticia-nao-real");
  await page.getByRole("button", { name: "Solicitar acesso" }).click();
  await expect(page.getByLabel("E-mail")).toHaveValue("");
  await expect(page.getByLabel("Senha", { exact: true })).toHaveValue("");
});

test("não interpreta falha ao carregar o perfil como aprovação pendente", async ({ page }) => {
  const masterId = "00000000-0000-4000-8000-000000000001";
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const accessToken = `${encode({ alg: "none", typ: "JWT" })}.${encode({ sub: masterId, aud: "authenticated", role: "authenticated", iat: now, exp: now + 3600 })}.${Buffer.from("e2e-signature").toString("base64url")}`;
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
    body: JSON.stringify({ session: { access_token: accessToken, refresh_token: "e2e-refresh", token_type: "bearer", expires_in: 3600, expires_at: now + 3600, user }, user }),
  }));
  await page.route("**/auth/v1/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    return path.endsWith("/logout")
      ? route.fulfill({ status: 204, body: "" })
      : route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(user) });
  });
  await page.route("**/rest/v1/profiles**", (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "profile unavailable" }) }));

  await page.goto("/");
  await dismissCookieNotice(page);
  await waitForApplicationReady(page);
  await page.getByLabel("Usuário ou e-mail").fill("master@valurise.invalid");
  await page.getByLabel("Senha", { exact: true }).fill("senha-ficticia-nao-real");
  await page.getByRole("button", { name: "Entrar na conta" }).click();
  await expect(page.getByText(/Não foi possível validar seu perfil agora/)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("heading", { name: "Acesso em análise" })).toHaveCount(0);
});

test("apresenta erro genérico quando o login falha", async ({ page }) => {
  let loginRequestSeen = false;
  await page.route("**/api/auth/login", (route) => {
    loginRequestSeen = true;
    return route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ error: "Login ou senha inválidos." }),
    });
  });
  await page.goto("/");
  await dismissCookieNotice(page);
  await waitForApplicationReady(page);
  await page.getByLabel("Usuário ou e-mail").fill("usuario-invalido");
  await page.getByLabel("Senha", { exact: true }).fill("senha-invalida-nao-real");
  await expect(page.getByLabel("Usuário ou e-mail")).toHaveValue("usuario-invalido");
  await expect(page.getByLabel("Senha", { exact: true })).toHaveValue("senha-invalida-nao-real");
  await page.getByRole("button", { name: "Entrar na conta" }).click();

  await expect.poll(() => loginRequestSeen).toBe(true);
  await expect(page.getByText("Login ou senha inválidos.")).toBeVisible();
});

test("impede envio duplicado enquanto o login está em andamento", async ({ page }) => {
  let requests = 0;
  await page.route("**/api/auth/login", async (route) => {
    requests += 1;
    await new Promise((resolve) => setTimeout(resolve, 150));
    await route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "Login ou senha inválidos." }) });
  });
  await page.goto("/");
  await dismissCookieNotice(page);
  await waitForApplicationReady(page);
  await page.getByLabel("Usuário ou e-mail").fill("usuario-teste");
  await page.getByLabel("Senha", { exact: true }).fill("senha-ficticia");
  await page.locator("form.login-card").evaluate((form: HTMLFormElement) => {
    form.requestSubmit();
    form.requestSubmit();
  });
  await expect.poll(() => requests).toBe(1);
  await expect(page.getByRole("button", { name: "Aguarde…" })).toBeVisible();
  await expect(page.getByText("Login ou senha inválidos.")).toBeVisible();
});
