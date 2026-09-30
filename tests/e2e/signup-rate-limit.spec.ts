import { test, expect } from "./fixtures";

test("explica com clareza quando uma nova solicitação de acesso é limitada", async ({ page }) => {
  await page.route("**/api/auth/request-access", (route) => route.fulfill({
    status: 429,
    contentType: "application/json",
    body: JSON.stringify({ error: "Você atingiu o limite de tentativas de cadastro. Aguarde até 1 hora e tente novamente." }),
  }));

  const necessary = page.getByRole("button", { name: "Apenas necessários" });
  await page.goto("/");
  await necessary.waitFor({ state: "visible", timeout: 5000 }).catch(() => undefined);
  if (await necessary.isVisible()) await necessary.click();
  await expect(page.locator('div[aria-hidden="false"] .login-shell')).toBeVisible({ timeout: 15_000 });

  await page.getByRole("button", { name: "Solicitar acesso" }).click();
  await page.getByLabel("Seu nome").fill("Pessoa de Teste");
  await page.getByLabel("Usuário").fill("teste.valurise");
  await page.getByLabel("E-mail").fill("teste@exemplo.invalid");
  await page.getByLabel("Senha", { exact: true }).fill("senha-e2e-ficticia");
  await page.getByLabel(/Política de Privacidade/).check();
  await page.getByLabel(/Termos de Uso/).check();
  await page.getByRole("button", { name: "Solicitar acesso", exact: true }).click();

  await expect(page.locator(".login-feedback-error")).toContainText("Aguarde até 1 hora e tente novamente.");
});
