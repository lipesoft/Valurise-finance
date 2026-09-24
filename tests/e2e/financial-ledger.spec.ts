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

function initialState(): { data: Record<string, unknown>; transactions: Record<string, unknown>[]; profile: Record<string, unknown> } {
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

async function loginWithFinancialSeed(page: Page, initialInvites: Record<string, unknown>[] = []) {
  let state = initialState();
  let version = 1;
  let invites = [...initialInvites];
  const sharedGoalId = "00000000-0000-4000-8000-000000000777";
  let contributions: Record<string, unknown>[] = [];
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
    if (url.pathname === "/rest/v1/shared_goal_invites") {
      const status = url.searchParams.get("status");
      const rows = invites.filter((invite) => !status || invite.status === status.replace("eq.", ""));
      return fulfillCors(route, 200, rows);
    }
    if (url.pathname === "/rest/v1/shared_goals") {
      const goal = {
        id: sharedGoalId,
        owner_id: "00000000-0000-4000-8000-000000000555",
        name: "Casa própria",
        target_cents: 30_000_000,
        target_date: "2030-01-01",
        initial_cents: 0,
        created_at: new Date().toISOString(),
        shared_goal_contributions: contributions,
      };
      return fulfillCors(route, 200, invites.some((invite) => invite.status === "accepted") ? [goal] : []);
    }
    if (url.pathname === "/rest/v1/rpc/respond_shared_goal_invite") {
      const body = request.postDataJSON() as { p_invite_id: string; p_accept: boolean };
      invites = invites.map((invite) => invite.id === body.p_invite_id
        ? { ...invite, status: body.p_accept ? "accepted" : "declined" }
        : invite);
      return fulfillCors(route, 200, {});
    }
    if (url.pathname === "/rest/v1/rpc/contribute_to_shared_goal") {
      const body = request.postDataJSON() as { p_amount_cents: number; p_transaction_date: string; p_account_label: string };
      const transaction = {
        id: "transaction-shared-e2e",
        type: "transfer",
        subtype: "goal_contribution",
        amountCents: body.p_amount_cents,
        category: "Meta • Casa própria",
        account: body.p_account_label,
        destinationAccount: "Meta • Casa própria",
        description: "Contribuição • Casa própria",
        date: body.p_transaction_date,
        createdAt: new Date().toISOString(),
        sharedGoalId,
      };
      state = { ...state, transactions: [...state.transactions, transaction] };
      version += 1;
      contributions = [...contributions, {
        id: "contribution-shared-e2e",
        user_id: user.id,
        amount_cents: body.p_amount_cents,
        note: "Contribuição registrada no Valurise",
        contributed_at: body.p_transaction_date,
      }];
      return fulfillCors(route, 200, { version, transaction });
    }
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

test("convite de meta chega, pode ser aceito e a meta compartilhada atualiza no dashboard e extrato", async ({ page }) => {
  await loginWithFinancialSeed(page, [{
    id: "invite-e2e",
    shared_goal_id: "00000000-0000-4000-8000-000000000777",
    status: "pending",
    created_at: new Date().toISOString(),
    shared_goals: { name: "Casa própria", target_cents: 300_000_00, target_date: "2030-01-01" },
  }]);

  const bell = page.getByRole("button", { name: "Abrir notificações (1)" });
  await expect(bell).toBeVisible();
  await bell.click();
  const notifications = page.getByRole("region", { name: "Notificações financeiras" });
  await expect(notifications.getByText("Casa própria")).toBeVisible();
  await expect(notifications.getByText(/outros dados financeiros continuam privados/)).toBeVisible();
  await notifications.getByRole("button", { name: "Aceitar convite" }).click();
  await expect(notifications.getByText("Tudo em dia")).toBeVisible();
  await expect(page.getByRole("button", { name: "Abrir notificações" })).toBeVisible();

  await page.getByRole("button", { name: "Metas", exact: true }).click();
  const goalCard = page.locator("article").filter({ hasText: "Casa própria" });
  await expect(goalCard).toContainText("Meta compartilhada");
  await expect(goalCard).toContainText("R$ 0,00 de R$ 300.000,00");
  await expect(goalCard.getByText("Extrato da meta")).toBeVisible();
  await goalCard.getByRole("button", { name: "+ Adicionar dinheiro" }).click();
  await page.getByLabel("Valor da contribuição").fill("125,00");
  await page.getByLabel("Conta de origem").selectOption("Banco Teste • Conta");
  await page.getByRole("button", { name: "Confirmar contribuição" }).click();
  await expect(goalCard).toContainText("R$ 125,00 de R$ 300.000,00");
  await expect(goalCard).toContainText("Você contribuiu");
  await expect(goalCard).toContainText("+R$ 125,00");

  await page.getByRole("button", { name: "Dashboard", exact: true }).click();
  const summary = page.locator(".panel").filter({ hasText: "Patrimônio total" });
  await expect(summary).toContainText("R$ 875,00");
  await expect(page.getByText("Casa própria").last()).toBeVisible();
});

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
