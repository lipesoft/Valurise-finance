import { test, expect } from "./fixtures";

const testUserId = "00000000-0000-4000-8000-000000000123";
const currentMonth = new Date().toISOString().slice(0, 7);
const mockState = {
  data: {
    categories: ["Moradia", "Alimentação", "Transporte"],
    institutions: [{
      id: "institution-qa",
      name: "Banco de teste",
      color: "#4edea3",
      accounts: [
        { id: "account-qa", name: "Conta principal", balance: 250000 },
        { id: "account-qa-dest", name: "Conta destino", balance: 100000 },
      ],
      cards: [],
    }],
    budgets: [{ id: "budget-qa", category: "Alimentação", limitCents: 100000, month: currentMonth }],
    goals: [{ id: "goal-qa", name: "Reserva QA", targetCents: 1000000, currentCents: 350000, targetDate: "2027-09-01" }],
    investments: [{ id: "investment-qa", name: "CDB QA", assetClass: "CDB", contributedCents: 200000, currentCents: 204000 }],
    recurringBills: [],
    onboarded: true,
  },
  transactions: [
    { id: "income-qa", type: "income", amountCents: 450000, category: "Salário", account: "Banco de teste • Conta principal", date: `${currentMonth}-05T12:00:00.000Z`, createdAt: `${currentMonth}-05T12:00:00.000Z` },
    { id: "expense-qa", type: "expense", amountCents: 40000, category: "Alimentação", account: "Banco de teste • Conta principal", description: "Mercado QA", date: `${currentMonth}-10T12:00:00.000Z`, createdAt: `${currentMonth}-10T12:00:00.000Z` },
  ],
  profile: { publicId: "VAL-QA-1234" },
};

async function installMockSession(page: import("@playwright/test").Page) {
  const authUser = {
    id: testUserId,
    aud: "authenticated",
    role: "authenticated",
    email: "qa@valurise.invalid",
    app_metadata: { provider: "email", providers: ["email"] },
    user_metadata: { full_name: "Pessoa de teste" },
    created_at: new Date().toISOString(),
  };
  const session = {
    access_token: "e2e-access-token-not-valid-outside-this-test",
    token_type: "bearer",
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    refresh_token: "e2e-refresh-token-not-valid-outside-this-test",
    user: authUser,
  };

  await page.route("**/auth/v1/user", (route) => route.fulfill({ status: 200, json: authUser }));
  await page.route("**/rest/v1/**", (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith("/profiles")) {
      return route.fulfill({ status: 200, json: { full_name: "Pessoa de teste", account_status: "active", account_role: "user", public_id: "VAL-QA-1234" } });
    }
    if (pathname.endsWith("/user_financial_state")) {
      return route.fulfill({ status: 200, json: { state: mockState, version: 1 } });
    }
    if (pathname.endsWith("/user_consents")) {
      return route.fulfill({ status: 200, json: { cookie_preference: "essential_only", cookie_policy_version: "2026-09-23-v1" } });
    }
    return route.fulfill({ status: 200, json: [] });
  });
  await page.addInitScript(({ storedSession, userId }) => {
    const bytes = new TextEncoder().encode(JSON.stringify(storedSession));
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const encoded = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    document.cookie = `sb-127-auth-token=base64-${encoded}; Path=/; SameSite=Lax`;
    localStorage.setItem(`valurise:v2:${userId}:data`, JSON.stringify(mockState.data));
    localStorage.setItem(`valurise:v2:${userId}:tx`, JSON.stringify(mockState.transactions));
    localStorage.setItem(`valurise:v2:${userId}:profile`, JSON.stringify(mockState.profile));
    localStorage.setItem("valurise:cookie-consent", JSON.stringify({ preference: "essential_only", version: "2026-09-23-v1" }));
  }, { storedSession: session, userId: testUserId });
}

test("dashboard mantém conteúdo, sem overflow horizontal, em 375, 390 e 430 px", async ({ page }) => {
  await installMockSession(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /Boa (manhã|tarde|noite), Pessoa de teste\./ })).toBeVisible();
  await expect(page.getByText("Mercado QA")).toBeVisible();

  for (const width of [375, 390, 430]) {
    await page.setViewportSize({ width, height: 844 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(page.getByText("Evolução financeira")).toBeVisible();
    await expect(page.getByText("Gestão por categoria")).toBeVisible();
  }

  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await expect.poll(() => page.locator("header").evaluate((header) => Math.abs(header.getBoundingClientRect().top))).toBeLessThanOrEqual(1);
});

test("navegação, formulários e controles mantêm dimensões em desktop e mobile", async ({ page }) => {
  test.setTimeout(60_000);
  await installMockSession(page);
  await page.goto("/");

  for (const width of [1280, 375, 390, 430]) {
    await page.setViewportSize({ width, height: 844 });
      const mobile = width < 1024;
      for (const view of ["Dashboard", "Extrato", "Contas", "Cartões", "Investimentos", "Orçamentos", "Metas", "Planejamento", "Relatórios", "Categorias", "Ajustes"]) {
      if (mobile) {
        await page.getByRole("button", { name: "Abrir menu" }).click();
        const menu = page.getByRole("dialog", { name: "Menu principal" });
        await menu.getByRole("button", { name: view, exact: true }).click();
        await expect(menu).toBeHidden();
      } else {
        await page.getByRole("button", { name: view, exact: true }).click();
      }
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

      if (view === "Dashboard") {
        const launcher = await page.getByRole("button", { name: "Registrar movimentação" }).boundingBox();
        expect(launcher).not.toBeNull();
        if (mobile) {
          expect(launcher!.width).toBe(56);
          expect(launcher!.height).toBe(56);
        } else {
          expect(launcher!.width).toBeLessThanOrEqual(320);
        }
      }

      if (view === "Contas") {
        const addButton = page.getByRole("button", { name: "Adicionar conta ou instituição" });
        await expect(addButton).toBeVisible();
        await addButton.click();
        const fieldHeights = await page.locator(".field").evaluateAll((elements) => elements.map((element) => (element as HTMLElement).offsetHeight));
        expect(fieldHeights.length).toBeGreaterThan(0);
        expect(fieldHeights.every((height) => height === 48), JSON.stringify(fieldHeights)).toBe(true);
        await page.getByRole("button", { name: "Fechar" }).click();
      }

      if (view === "Ajustes") {
        const checkboxSizes = await page.locator('input[type="checkbox"]').evaluateAll((elements) => elements.map((element) => {
          const { offsetWidth: checkboxWidth, offsetHeight: height } = element as HTMLInputElement;
          return { width: checkboxWidth, height };
        }));
        expect(checkboxSizes.every((checkbox) => checkbox.width === 18 && checkbox.height === 18)).toBe(true);
      }
    }

    const headerButtons = await page.locator("header button[aria-label]").evaluateAll((elements) => elements.filter((element) => element.getClientRects().length > 0).map((element) => {
      const { width: buttonWidth, height } = element.getBoundingClientRect();
      return { width: buttonWidth, height };
    }));
    expect(headerButtons.length).toBeGreaterThan(0);
    expect(headerButtons.every((button) => button.width === 44 && button.height === 44)).toBe(true);
  }
});

test("transferência exige origem e destino e registra ambos sem alterar o patrimônio", async ({ page }) => {
  await installMockSession(page);
  await page.goto("/");

  await page.getByRole("button", { name: "Registrar movimentação" }).click();
  await page.getByRole("button", { name: "Transferi" }).click();
  await page.getByPlaceholder("R$ 0,00").fill("25,00");
  await page.getByRole("button", { name: "Continuar" }).click();

  await expect(page.getByText(/De qual conta saiu\?/)).toBeVisible();
  await page.getByRole("button", { name: "Banco de teste • Conta principal" }).click();
  await page.getByRole("button", { name: "Continuar" }).click();
  await expect(page.getByText(/Para qual conta foi\?/)).toBeVisible();
  await page.getByRole("button", { name: "Banco de teste • Conta destino" }).click();
  await page.getByRole("button", { name: "Continuar" }).click();
  await page.getByRole("button", { name: "Continuar" }).click();

  await expect(page.locator("p").filter({ hasText: "Banco de teste • Conta principal → Banco de teste • Conta destino" })).toBeVisible();
  await page.getByRole("button", { name: "Confirmar lançamento" }).click();

  const transactions = await page.evaluate((storageKey) => JSON.parse(localStorage.getItem(storageKey) || "[]"), `valurise:v2:${testUserId}:tx`);
  const transfer = transactions.find((item: { type: string }) => item.type === "transfer");
  expect(transfer).toMatchObject({
    type: "transfer",
    amountCents: 2500,
    account: "Banco de teste • Conta principal",
    destinationAccount: "Banco de teste • Conta destino",
  });
});

test("planejamento cria, edita e exclui uma conta recorrente", async ({ page }) => {
  await installMockSession(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Planejamento" }).click();
  await page.getByRole("button", { name: "Adicionar conta recorrente" }).click();

  await page.getByPlaceholder("Ex.: Internet, aluguel, Netflix").fill("Internet QA");
  await page.getByPlaceholder("Valor mensal").fill("89,90");
  await page.getByPlaceholder("Dia de vencimento").fill("28");
  await page.getByPlaceholder("Categoria (opcional)").fill("Moradia");
  await page.getByRole("button", { name: "Criar conta recorrente" }).click();
  await expect(page.getByText("Internet QA", { exact: false }).first()).toBeVisible();

  await page.getByRole("button", { name: "Editar a conta recorrente Internet QA" }).click();
  await page.getByPlaceholder("Ex.: Internet, aluguel, Netflix").fill("Internet QA editada");
  await page.getByPlaceholder("Valor mensal").fill("99,90");
  await page.getByRole("button", { name: "Salvar alterações" }).click();
  await expect(page.getByRole("button", { name: "Excluir a conta recorrente Internet QA editada" })).toBeVisible();

  await page.getByRole("button", { name: "Excluir a conta recorrente Internet QA editada" }).click();
  await page.getByRole("button", { name: "Excluir", exact: true }).click();
  await expect(page.getByText("Nenhuma conta recorrente.")).toBeVisible();

  const savedData = await page.evaluate((storageKey) => JSON.parse(localStorage.getItem(storageKey) || "{}"), `valurise:v2:${testUserId}:data`);
  expect(savedData.recurringBills).toEqual([]);
});

test("backup JSON substitui somente dados financeiros após confirmação", async ({ page }) => {
  await installMockSession(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Ajustes" }).click();

  const backup = {
    format: "valurise-backup",
    version: 1,
    exportedAt: "2026-09-23T12:00:00.000Z",
    data: { categories: ["Importada QA"], institutions: [], onboarded: true },
    transactions: [{
      id: "backup-transaction-qa",
      type: "expense",
      amountCents: 1234,
      category: "Importada QA",
      account: "Conta de teste",
      date: "2026-09-23T12:00:00.000Z",
      createdAt: "2026-09-23T12:00:00.000Z",
    }],
  };
  await page.locator('input[type="file"][accept=".json,application/json"]').setInputFiles({
    name: "valurise-backup.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(backup)),
  });
  await expect(page.getByText("Restaurar backup?")).toBeVisible();
  await page.getByRole("button", { name: "Restaurar dados" }).click();

  const storagePrefix = `valurise:v2:${testUserId}`;
  const savedData = await page.evaluate((key) => JSON.parse(localStorage.getItem(`${key}:data`) || "{}"), storagePrefix);
  const savedTransactions = await page.evaluate((key) => JSON.parse(localStorage.getItem(`${key}:tx`) || "[]"), storagePrefix);
  expect(savedData.categories).toEqual(["Importada QA"]);
  expect(savedTransactions).toHaveLength(1);
  expect(savedTransactions[0]).toMatchObject({ id: "backup-transaction-qa", amountCents: 1234 });
  await expect(page.getByText("Backup restaurado e sincronização iniciada.")).toBeVisible();
});
