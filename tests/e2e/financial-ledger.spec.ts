import { test, expect } from "./fixtures";
import type { Page, Route } from "@playwright/test";

const supabaseOrigin = "http://127.0.0.1:54321";
const user = {
  id: "00000000-0000-4000-8000-000000000124",
  aud: "authenticated",
  role: "authenticated",
  email: "financeiro@valurise.invalid",
  app_metadata: { provider: "email", providers: ["email"] },
  user_metadata: { full_name: "Pessoa de teste" },
  created_at: new Date().toISOString(),
};

function initialState() {
  return {
    data: {
      categories: ["Alimentação"],
      institutions: [{
        id: "institution-e2e",
        name: "Banco Teste",
        color: "#34d399",
        accounts: [{ id: "account-e2e", name: "Conta", balance: 100000 }],
        cards: [{ id: "card-e2e", name: "Cartão", limit: 200000, closingDay: "10", dueDay: "17" }],
      }],
      investments: [{ id: "investment-e2e", name: "CDB Reserva", assetClass: "CDB", contributedCents: 10000, currentCents: 12000 }],
      goals: [{ id: "goal-e2e", name: "Reserva", targetCents: 50000, currentCents: 10000 }],
      recurringBills: [],
      onboarded: true,
    },
    transactions: [],
    profile: { publicId: "VAL-E2E0001" },
  };
}

async function fulfillCors(route: Route, status: number, body?: unknown) {
  await route.fulfill({
    status,
    contentType: "application/json",
    headers: {
      "access-control-allow-origin": "http://127.0.0.1:3000",
      "access-control-allow-credentials": "true",
      "access-control-allow-headers": "*",
      "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
    },
    body: body === undefined ? "" : JSON.stringify(body),
  });
}

async function loginWithFinancialSeed(page: Page) {
  let state = initialState();
  let version = 1;
  const profile = {
    full_name: "Pessoa de teste",
    account_status: "active",
    account_role: "user",
    public_id: "VAL-E2E0001",
  };

  await page.route(`${supabaseOrigin}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "OPTIONS") return fulfillCors(route, 204);

    if (url.pathname === "/auth/v1/user") return fulfillCors(route, 200, user);
    if (url.pathname === "/rest/v1/profiles") return fulfillCors(route, 200, profile);
    if (url.pathname === "/rest/v1/shared_goal_invites") return fulfillCors(route, 200, []);
    if (url.pathname === "/rest/v1/user_financial_state") {
      if (request.method() === "GET") return fulfillCors(route, 200, { state, version });
      if (request.method() === "PATCH") {
        const patch = request.postDataJSON() as { state?: typeof state; version?: number };
        if (patch.state) state = patch.state;
        version = patch.version || version + 1;
        return fulfillCors(route, 200, { version });
      }
    }

    return fulfillCors(route, 200, []);
  });

  const session = {
    access_token: "e2e-access-token-not-valid-outside-this-test",
    refresh_token: "e2e-refresh-token-not-valid-outside-this-test",
    token_type: "bearer",
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user,
  };
  await page.addInitScript(({ storedSession }) => {
    const bytes = new TextEncoder().encode(JSON.stringify(storedSession));
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const encoded = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    document.cookie = `sb-127-auth-token=base64-${encoded}; Path=/; SameSite=Lax`;
    localStorage.setItem("valurise:cookie-consent", JSON.stringify({ preference: "essential_only", version: "2026-09-23-v1" }));
  }, { storedSession: session });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: /Pessoa de teste/ })).toBeVisible({ timeout: 20_000 });
}

test("registra aporte com conta de origem e reverte o saldo ao excluir o lançamento", async ({ page }) => {
  await loginWithFinancialSeed(page);
  await page.getByRole("button", { name: "Investimentos", exact: true }).click();
  await page.getByRole("button", { name: /Registrar aporte/ }).click();

  await page.getByLabel("Valor do aporte").fill("250,00");
  await page.getByLabel("Conta de origem").selectOption("Banco Teste • Conta");
  await page.getByRole("button", { name: "Confirmar aporte" }).click();

  const investmentCard = page.locator("article").filter({ hasText: "CDB Reserva" });
  await expect(investmentCard).toContainText("Aportado R$ 350,00");
  await expect(page.getByText("Últimos aportes")).toBeVisible();
  await expect(page.getByText(/Banco Teste • Conta/).last()).toBeVisible();

  await page.getByRole("button", { name: "Extrato", exact: true }).click();
  await page.getByRole("button", { name: /Aporte • CDB Reserva/ }).click();
  await page.getByRole("button", { name: "Excluir", exact: true }).click();
  await page.getByRole("button", { name: "Excluir", exact: true }).last().click();
  await page.getByRole("button", { name: "Investimentos", exact: true }).click();
  await expect(page.locator("article").filter({ hasText: "CDB Reserva" })).toContainText("Aportado R$ 100,00");
});

test("contribuição de meta debita a conta, aparece no histórico e não vira despesa", async ({ page }) => {
  await loginWithFinancialSeed(page);
  await page.getByRole("button", { name: "Metas", exact: true }).click();
  await page.getByRole("button", { name: "+ Adicionar dinheiro" }).click();

  await page.getByLabel("Valor da contribuição").fill("125,00");
  await page.getByLabel("Conta de origem").selectOption("Banco Teste • Conta");
  await page.getByRole("button", { name: "Confirmar contribuição" }).click();

  const goalCard = page.locator("article").filter({ hasText: "Reserva" });
  await expect(goalCard).toContainText("R$ 225,00 de R$ 500,00");
  await expect(page.getByText("Contribuições recentes")).toBeVisible();
  await expect(page.getByText(/Banco Teste • Conta/).last()).toBeVisible();

  await page.getByRole("button", { name: "Dashboard", exact: true }).click();
  const summaryCard = page.locator(".panel").filter({ hasText: "Patrimônio total" });
  await expect(summaryCard).toContainText("Saldo disponível");
  await expect(summaryCard).toContainText("R$ 875,00");
  const consumptionMetric = page.getByText("Consumo", { exact: true }).first().locator("..");
  await expect(consumptionMetric).toContainText("R$ 0,00");
});

test("parcelamento no cartão divide centavos, cria parcelas futuras e reserva limite", async ({ page }) => {
  await loginWithFinancialSeed(page);
  await page.getByRole("button", { name: "Registrar movimentação" }).click();
  await page.getByRole("button", { name: "Gastei", exact: true }).click();
  await page.getByPlaceholder("R$ 0,00").fill("100,00");
  await page.getByRole("button", { name: "Continuar" }).click();
  await page.getByRole("button", { name: "Alimentação", exact: true }).click();
  await page.getByRole("button", { name: "Continuar" }).click();
  await page.getByRole("button", { name: "Banco Teste • Cartão", exact: true }).click();
  await page.getByRole("button", { name: "Continuar" }).click();
  await page.getByLabel("Parcelamento da compra").selectOption("3");
  await page.getByRole("button", { name: "Continuar" }).click();
  await expect(page.getByRole("dialog")).toContainText(/3 parcelas de.*33,33.*33,34/);
  await page.getByRole("button", { name: "Confirmar lançamento" }).click();

  await page.getByRole("button", { name: "Extrato", exact: true }).click();
  await expect(page.getByText("Parcela 1/3")).toBeVisible();
  await page.getByRole("button", { name: "Todo histórico" }).click();
  await expect(page.getByText("Parcela 2/3 · Programada")).toBeVisible();
  await expect(page.getByText("Parcela 3/3 · Programada")).toBeVisible();

  await page.getByRole("button", { name: "Planejamento", exact: true }).click();
  await expect(page.getByText(/Comprometido:/)).toContainText(/100,00/);
  await expect(page.getByText(/Próxima fatura:/)).toContainText(/33,33/);
  await expect(page.getByText(/disponível:/)).toContainText(/1\.900,00/);
});
