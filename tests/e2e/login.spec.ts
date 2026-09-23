import { test, expect } from "./fixtures";

async function dismissCookieNotice(page: import("@playwright/test").Page) {
  const necessary = page.getByRole("button", { name: "Apenas necessários" });
  await necessary.waitFor({ state: "visible", timeout: 5000 }).catch(() => undefined);
  if (await necessary.isVisible()) await necessary.click();
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
  await expect(page.getByLabel("Identificação")).toBeVisible();
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
  }
});

test("orienta o próximo passo sem afirmar que toda tentativa virou pedido pendente", async ({ page }) => {
  await page.route("**/api/auth/request-access", (route) => route.fulfill({
    status: 202,
    contentType: "application/json",
    body: JSON.stringify({ ok: true }),
  }));
  await page.goto("/");
  await dismissCookieNotice(page);
  await page.getByRole("button", { name: "Criar conta" }).click();

  await page.getByLabel("Seu nome").fill("Pessoa de Teste");
  await page.getByLabel("Usuário").fill("teste.valurise");
  await page.getByLabel("E-mail").fill("teste@exemplo.invalid");
  await page.getByLabel("Senha", { exact: true }).fill("senha-e2e-ficticia");
  await page.getByLabel(/Política de Privacidade/).check();
  await page.getByLabel(/Termos de Uso/).check();
  await page.getByRole("button", { name: "Solicitar cadastro" }).click();

  await expect(page.getByRole("heading", { name: "Verifique o próximo passo do seu acesso" })).toBeVisible();
  await expect(page.getByText(/Se este for um cadastro novo, sua solicitação está aguardando aprovação do Master/)).toBeVisible();
  await expect(page.getByText(/nenhum pedido novo foi criado/)).toBeVisible();
});

test("mostra a resposta segura ao pedir recuperação de senha", async ({ page }) => {
  await page.route("**/api/auth/password-reset", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true }),
  }));
  await page.goto("/");
  await dismissCookieNotice(page);
  await page.getByRole("button", { name: "Esqueci minha senha" }).click();
  await page.getByLabel("E-mail").fill("teste@exemplo.invalid");
  await page.getByRole("button", { name: "Enviar link seguro" }).click();

  await expect(page.getByText("Se o e-mail estiver cadastrado, enviamos um link seguro para redefinir sua senha.")).toBeVisible();
});

test("apresenta erro genérico quando o login falha", async ({ page }) => {
  await page.route("**/api/auth/login", (route) => route.fulfill({
    status: 401,
    contentType: "application/json",
    body: JSON.stringify({ error: "Login ou senha inválidos." }),
  }));
  await page.goto("/");
  await dismissCookieNotice(page);
  await page.getByLabel("Identificação").fill("usuario-invalido");
  await page.getByLabel("Senha", { exact: true }).fill("senha-invalida-nao-real");
  await page.getByRole("button", { name: "Entrar na conta" }).click();

  await expect(page.getByText("Login ou senha inválidos.")).toBeVisible();
});
