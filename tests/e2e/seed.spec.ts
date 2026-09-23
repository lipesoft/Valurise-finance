import { test, expect } from "./fixtures";

test.describe("Preparação segura do ambiente E2E", () => {
  test("a aplicação inicia na tela de acesso Valurise", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "VALURISE" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Acesse sua conta" })).toBeVisible();
  });
});
