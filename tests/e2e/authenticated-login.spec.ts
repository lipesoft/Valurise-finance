import { test, expect } from "./fixtures";

const credentials = [
  "E2E_SUPABASE_URL",
  "E2E_SUPABASE_PUBLISHABLE_KEY",
  "E2E_SUPABASE_SECRET_KEY",
  "E2E_TEST_IDENTIFIER",
  "E2E_TEST_PASSWORD",
] as const;
const configured = credentials.every((name) => Boolean(process.env[name]));

test.skip(!configured, "Autenticação E2E real requer um projeto Supabase e usuário de teste não produtivos.");
test.use({ trace: "off", screenshot: "off", video: "off" });

test("entra com conta de teste e consegue sair", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByLabel("Usuário ou e-mail").fill(process.env.E2E_TEST_IDENTIFIER!);
  await page.getByLabel("Senha").fill(process.env.E2E_TEST_PASSWORD!);
  await page.getByRole("button", { name: "Entrar na conta" }).click();

  await expect(page.getByText(/Patrimônio disponível|Patrimônio total/)).toBeVisible({ timeout: 30_000 });
  const logout = page.getByRole("button", { name: /Sair|Encerrar sessão|Logout/i });
  await expect(logout).toBeVisible();
  await logout.click();
  await expect(page.getByRole("heading", { name: "Acesse sua conta" })).toBeVisible();
});
