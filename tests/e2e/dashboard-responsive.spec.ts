import { test, expect } from "./fixtures";

const testUserId = "00000000-0000-4000-8000-000000000123";
const personalWorkspaceId = "00000000-0000-4000-8000-000000000234";
const businessWorkspaceId = "00000000-0000-4000-8000-000000000345";
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
    budgets: [{ id: "budget-qa", category: "Alimentação", limitCents: 50000, month: currentMonth }],
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
const mockBusinessState = {
  data: {
    categories: ["Vendas", "Custos"],
    institutions: [{ id: "business-institution-qa", name: "Banco Empresa QA", color: "#4edea3", accounts: [{ id: "business-account-qa", name: "Conta da empresa", balance: 100000 }], cards: [] }],
    recurringBills: [],
    onboarded: false,
  },
  transactions: [
    { id: "business-income-qa", type: "income", amountCents: 450000, category: "Vendas", account: "Banco Empresa QA • Conta da empresa", date: `${currentMonth}-05T12:00:00.000Z`, createdAt: `${currentMonth}-05T12:00:00.000Z` },
    { id: "business-expense-qa", type: "expense", amountCents: 120000, category: "Custos", account: "Banco Empresa QA • Conta da empresa", date: `${currentMonth}-10T12:00:00.000Z`, createdAt: `${currentMonth}-10T12:00:00.000Z` },
  ],
  profile: { publicId: "VAL-QA-BUSINESS" },
};

async function installMockSession(page: import("@playwright/test").Page, financialStateDelayMs = 0, financialStateFails = false) {
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
  await page.route("**/api/workspaces", (route) => route.fulfill({ status: 200, json: {
    activeWorkspaceId: personalWorkspaceId,
    workspaces: [{ id: personalWorkspaceId, type: "personal", displayName: "Pessoa de teste", role: "owner" }],
  } }));
  await page.route("**/api/workspaces/active", async (route) => {
    const body = route.request().postDataJSON() as { workspaceId?: string };
    return route.fulfill({ status: 200, json: { ok: true, activeWorkspaceId: body.workspaceId } });
  });
  await page.route("**/api/workspaces/business", (route) => route.fulfill({ status: 201, json: {
    ok: true,
    workspace: { id: businessWorkspaceId, type: "business", displayName: "Empresa QA", role: "owner" },
  } }));
  let businessProfile = {
    workspace_id: businessWorkspaceId, legal_name: "Empresa QA Serviços LTDA", trade_name: "Empresa QA", cnpj: "11222333000181",
    email: null, phone: null, postal_code: null, street: null, number: null, address_complement: null, neighborhood: null,
    city: null, state: null, activity_start_date: null, cnae: null, tax_regime: null, accountant_name: null,
    management_close_day: null, default_currency: "BRL", timezone: "America/Sao_Paulo",
  };
  const businessAssumptions: Record<string, { metricKey: string; amountCents: number; nature: "reported" | "estimated"; source: "manual"; referenceMonth: string; createdAt: string } | null> = {};
  await page.route("**/api/workspaces/business/profile**", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ status: 200, json: { profile: businessProfile, assumptions: businessAssumptions, referenceMonth: currentMonth } });
    const body = route.request().postDataJSON() as { section: string; profile?: Record<string, unknown>; referenceMonth?: string; assumptions?: { metricKey: string; amountCents: number | null; nature: "reported" | "estimated" }[] };
    if (body.section === "company" && body.profile) businessProfile = { ...businessProfile, ...body.profile } as typeof businessProfile;
    if (body.section === "finance") for (const item of body.assumptions || []) {
      businessAssumptions[item.metricKey] = item.amountCents === null ? null : {
        metricKey: item.metricKey, amountCents: item.amountCents, nature: item.nature, source: "manual",
        referenceMonth: `${body.referenceMonth}-01`, createdAt: new Date().toISOString(),
      };
    }
    return route.fulfill({ status: 200, json: { ok: true, saved: body.assumptions?.length || 0 } });
  });
  await page.route("**/rest/v1/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith("/profiles")) {
      return route.fulfill({ status: 200, json: { full_name: "Pessoa de teste", account_status: "active", account_role: "user", public_id: "VAL-QA-1234" } });
    }
    if (pathname.endsWith("/user_financial_state")) {
      if (financialStateFails) {
        return route.fulfill({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({ code: "PGRST116", message: "Falha simulada no teste" }),
        });
      }
      if (financialStateDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, financialStateDelayMs));
      }
      const requestedWorkspace = new URL(route.request().url()).searchParams.get("workspace_id")?.replace(/^eq\./, "");
      const state = requestedWorkspace === businessWorkspaceId ? mockBusinessState : mockState;
      return route.fulfill({ status: 200, json: { state, version: 1 } });
    }
    if (pathname.endsWith("/user_consents")) {
      return route.fulfill({ status: 200, json: { cookie_preference: "essential_only", cookie_policy_version: "2026-09-23-v1" } });
    }
    return route.fulfill({ status: 200, json: [] });
  });
  await page.route("**/api/personal-ai/connection", (route) => {
    if (route.request().method() === "GET") return route.fulfill({ status: 200, json: { connection: { available: false, insights_enabled: false, actions_enabled: false, actions_allowed: true, consentRenewalRequired: false } } });
    return route.fulfill({ status: 200, json: { ok: true, connection: { available: false, insights_enabled: false, actions_enabled: false, actions_allowed: true, consentRenewalRequired: false } } });
  });
  await page.route("**/api/personal-ai/usage", (route) => route.fulfill({ status: 200, json: {
    available: true,
    usage: {
      today: { requests: 2, limit: 10, remaining: 8 },
      month: { requests: 4, limit: 200, remaining: 196, tokens: 140 },
    },
  } }));
  await page.route("**/api/personal-ai/chat", (route) => {
    if (route.request().method() === "GET") return route.fulfill({ status: 200, json: { messages: [] } });
    return route.fulfill({ status: 200, json: { reply: "Resposta financeira fictícia do teste.", usage: { totalTokens: 25 } } });
  });
  await page.route("**/api/personal-ai/actions", (route) => {
    if (route.request().method() === "GET") return route.fulfill({ status: 200, json: { proposals: [] } });
    return route.fulfill({ status: 200, json: { ok: true, decision: "rejected" } });
  });
  await page.addInitScript(({ storedSession, userId }) => {
    const bytes = new TextEncoder().encode(JSON.stringify(storedSession));
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const encoded = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    document.cookie = `sb-127-auth-token=base64-${encoded}; Path=/; SameSite=Lax`;
    const workspaceKey = `valurise:v2:${userId}:workspace:${personalWorkspaceId}`;
    localStorage.setItem(`${workspaceKey}:data`, JSON.stringify(mockState.data));
    localStorage.setItem(`${workspaceKey}:tx`, JSON.stringify(mockState.transactions));
    localStorage.setItem(`${workspaceKey}:profile`, JSON.stringify(mockState.profile));
    localStorage.setItem("valurise:cookie-consent", JSON.stringify({ preference: "essential_only", version: "2026-09-23-v1" }));
  }, { storedSession: session, userId: testUserId });
}

test("cria empresa isolada e troca contexto sem mostrar os dados pessoais", async ({ page }) => {
  await page.setViewportSize({ width: 1348, height: 618 });
  await installMockSession(page);
  await page.goto("/");
  const personalGreeting = page.getByRole("heading", { name: /^(Bom dia|Boa tarde|Boa noite), Pessoa de teste\.$/ });
  await expect(personalGreeting).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Mercado QA")).toBeVisible();
  await page.getByRole("button", { name: "Alternar espaço financeiro" }).click();
  await expect(page.getByRole("menu", { name: "Espaços financeiros" })).toBeVisible();
  await expect(page.getByRole("menuitemradio", { name: /Pessoal.*Pessoa de teste/ })).toHaveAttribute("aria-checked", "true");
  await page.getByRole("menuitem", { name: "Criar espaço empresarial" }).click();
  const dialog = page.getByRole("dialog", { name: "Criar espaço empresarial" });
  await dialog.getByLabel("Nome fantasia").fill("Empresa QA");
  await dialog.getByLabel("Razão social").fill("Empresa QA Serviços LTDA");
  await dialog.getByLabel("CNPJ").fill("11.222.333/0001-81");
  await dialog.getByRole("button", { name: "Criar empresa" }).click();

  await expect(page.getByRole("heading", { name: "Empresa QA", exact: true })).toBeVisible();
  await expect(page.getByText("Mercado QA")).toHaveCount(0);
  await page.getByRole("button", { name: "Pular por enquanto" }).click();
  await expect(page.getByRole("button", { name: "Registrar movimentação" })).toBeVisible();
  await expect(page.locator("h1")).toHaveText("Empresa QA");
  const businessSummary = page.getByRole("region", { name: "Resumo empresarial" });
  await expect(businessSummary).toBeVisible();
  const summaryBounds = await businessSummary.boundingBox();
  expect(summaryBounds?.width ?? 0).toBeGreaterThan(1000);
  const primaryMetricGrid = businessSummary.locator(".mt-4.grid").first();
  await expect.poll(() => primaryMetricGrid.evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length)).toBe(4);
  await expect(businessSummary.locator("article").first().locator("p").nth(1)).toHaveCSS("white-space", "nowrap");
  await expect(page.getByText("Total", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Disponível para gastar", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Organizar cards do Dashboard" })).toHaveCount(0);

  await page.getByRole("button", { name: "Alternar espaço financeiro" }).click();
  await page.getByRole("menuitemradio", { name: /Pessoal.*Pessoa de teste/ }).click();
  await expect(personalGreeting).toBeVisible();
  await expect(page.getByText("Total", { exact: true })).toBeVisible();
  await expect(page.getByText("Mercado QA")).toBeVisible();
  await page.getByRole("button", { name: "Alternar espaço financeiro" }).click();
  await page.getByRole("menuitemradio", { name: /Empresa QA.*Espaço empresarial/ }).click();
  await expect(page.getByRole("heading", { name: "Empresa QA", exact: true })).toBeVisible();
  await expect(personalGreeting).toHaveCount(0);
  await expect(page.getByText("Mercado QA")).toHaveCount(0);
});

test("receita prevista empresarial aparece no resumo sem alterar valores realizados", async ({ page }) => {
  await installMockSession(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /^(Bom dia|Boa tarde|Boa noite), Pessoa de teste\.$/ })).toBeVisible({ timeout: 15_000 });

  await page.getByRole("button", { name: "Alternar espaço financeiro" }).click();
  await page.getByRole("menuitem", { name: "Criar espaço empresarial" }).click();
  const dialog = page.getByRole("dialog", { name: "Criar espaço empresarial" });
  await dialog.getByLabel("Nome fantasia").fill("Empresa QA");
  await dialog.getByLabel("Razão social").fill("Empresa QA Serviços LTDA");
  await dialog.getByLabel("CNPJ").fill("11.222.333/0001-81");
  await dialog.getByRole("button", { name: "Criar empresa" }).click();

  await expect(page.getByRole("heading", { name: "Empresa QA", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Pular por enquanto" }).click();
  await expect(page.getByRole("region", { name: "Resumo empresarial" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Resumo empresarial" })).not.toContainText("R$ 750,00");

  await page.getByRole("button", { name: "Receitas", exact: true }).click();
  await page.getByRole("button", { name: "Adicionar receita", exact: true }).click();
  await page.getByLabel("Origem da receita").fill("Contrato empresa QA");
  await page.getByLabel("Valor previsto").fill("750,00");
  await page.getByLabel("Repetição da receita").selectOption("monthly");
  await page.getByLabel("Conta onde será recebido").selectOption("Banco Empresa QA • Conta da empresa");
  await page.getByRole("button", { name: "Adicionar receita", exact: true }).last().click();
  await page.getByRole("button", { name: "Dashboard", exact: true }).click();

  await expect(page.getByRole("region", { name: "Resumo empresarial" })).toContainText("A receber · programado");
  await expect(page.getByRole("region", { name: "Resumo empresarial" })).toContainText("R$ 750,00");
  await expect(page.getByRole("region", { name: "Resumo empresarial" })).not.toContainText("Receita realizada");
});

test("salva referências empresariais, distingue realizado de estimado e mantém o mobile utilizável", async ({ page }) => {
  await installMockSession(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Alternar espaço financeiro" }).click();
  await page.getByRole("menuitem", { name: "Criar espaço empresarial" }).click();
  const dialog = page.getByRole("dialog", { name: "Criar espaço empresarial" });
  await dialog.getByLabel("Nome fantasia").fill("Empresa QA");
  await dialog.getByLabel("Razão social").fill("Empresa QA Serviços LTDA");
  await dialog.getByLabel("CNPJ").fill("11.222.333/0001-81");
  await dialog.getByRole("button", { name: "Criar empresa" }).click();
  await page.getByRole("button", { name: "Completar perfil financeiro" }).click();
  await expect(page.getByRole("heading", { name: "Perfil financeiro da empresa" })).toBeVisible();
  await expect(page.getByText("Não precisa ter os números exatos agora.")).toHaveCount(0);
  await page.getByRole("button", { name: "Ajuda: Valores informados e estimativas" }).click();
  await expect(page.getByRole("region", { name: "Valores informados e estimativas" })).toContainText("Valores aproximados serão identificados como estimativas");
  await page.getByRole("button", { name: "Ajuda: Valores informados e estimativas" }).click();
  await page.getByLabel("Faturamento médio mensal").fill("5000,00");
  await page.getByLabel("Custos diretos médios").fill("1000,00");
  await page.getByLabel("Despesas fixas médias").fill("500,00");
  await page.getByLabel("Despesas variáveis médias").fill("300,00");
  await page.getByLabel("Folha e pessoal médios").fill("500,00");
  await page.getByLabel("Impostos provisionados médios").fill("200,00");
  await page.getByLabel("Contas a receber estimadas").fill("1000,00");
  await page.getByLabel("Contas a pagar estimadas").fill("800,00");
  await page.getByLabel("Saldo inicial informado").fill("3000,00");
  await page.getByRole("button", { name: "Salvar perfil financeiro" }).click();
  await expect(page.getByText("Perfil financeiro salvo com histórico e origem dos valores.")).toBeVisible();
  await page.getByRole("button", { name: "Dashboard" }).click();
  await expect(page.getByRole("heading", { name: "Visão da empresa" })).toBeVisible();
  await expect(page.getByText("Realizado", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Estimado", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Resultado gerencial", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("DRE gerencial simplificada")).toBeVisible();
  await expect(page.getByText("Fluxo de caixa registrado")).toBeVisible();
  await expect(page.getByText("Ponto de equilíbrio gerencial mensal")).toBeVisible();
  for (const width of [375, 390, 430]) {
    await page.setViewportSize({ width, height: 844 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
});

test("Configurações mantêm as explicações longas acessíveis pelo botão de ajuda em telas móveis", async ({ page }) => {
  await installMockSession(page);
  await page.setViewportSize({ width: 375, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "Abrir menu" }).click();
  const menu = page.getByRole("dialog", { name: "Menu principal" });
  await menu.getByRole("button", { name: "Configurações" }).click();
  await expect(page.getByRole("heading", { name: "Configurações" })).toBeVisible();
  await expect(page.getByText("Exporte uma cópia dos dados financeiros ou restaure um arquivo JSON.")).toHaveCount(0);
  await expect(page.getByText("A chave é enviada ao servidor e criptografada antes de ser salva.")).toHaveCount(0);

  const backupHelp = page.getByRole("button", { name: "Ajuda: Backup e importação" });
  const backupText = "Exporte uma cópia dos dados financeiros ou restaure um arquivo JSON.";
  const helpRegion = page.getByRole("region", { name: "Backup e importação" });
  for (const width of [375, 390, 430]) {
    await page.setViewportSize({ width, height: 844 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(backupHelp).toBeVisible();
    const helpTriggerBounds = await backupHelp.boundingBox();
    expect(helpTriggerBounds).not.toBeNull();
    expect(helpTriggerBounds!.width).toBeLessThanOrEqual(34);
    expect(helpTriggerBounds!.height).toBeLessThanOrEqual(34);
    await backupHelp.click();
    await expect(helpRegion).toContainText(backupText);
    const helpBounds = await helpRegion.boundingBox();
    expect(helpBounds).not.toBeNull();
    expect(helpBounds!.x).toBeGreaterThanOrEqual(0);
    expect(helpBounds!.x + helpBounds!.width).toBeLessThanOrEqual(width + 1);
    await backupHelp.click();
    await expect(helpRegion).toHaveCount(0);
  }

  const aiHelpButton = page.getByRole("button", { name: "Ajuda: Privacidade e funcionamento da Val" });
  await aiHelpButton.focus();
  await page.keyboard.press("Enter");
  const aiHelpRegion = page.getByRole("region", { name: "Privacidade e funcionamento da Val" });
  await expect(aiHelpRegion).toContainText("Você não precisa cadastrar chaves nem escolher modelos.");
  await page.keyboard.press("Escape");
  await expect(aiHelpRegion).toHaveCount(0);
  await expect(aiHelpButton).toBeFocused();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("atualiza a disponibilidade da Val depois de uma pausa temporária do serviço", async ({ page }) => {
  await installMockSession(page);
  let checks = 0;
  let serviceAvailable = false;
  await page.route("**/api/personal-ai/connection", async (route) => {
    checks += 1;
    return route.fulfill({ status: 200, json: { connection: {
      available: serviceAvailable,
      insights_enabled: false,
      actions_enabled: false,
      actions_allowed: true,
      consentRenewalRequired: false,
    } } });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Configurações", exact: true }).click();
  await expect(page.getByRole("status").getByText("Val temporariamente indisponível")).toBeVisible();
  serviceAvailable = true;
  await page.getByRole("button", { name: "Verificar agora" }).click();
  await expect(page.getByRole("status").getByText("Val disponível")).toBeVisible();
  expect(checks).toBeGreaterThanOrEqual(2);
});

test("splash acompanha a sincronização real e expande a marca suavemente na entrada", async ({ page }) => {
  await installMockSession(page, 4000);
  await page.setViewportSize({ width: 375, height: 844 });
  await page.goto("/");

  await expect(page.getByText("Sincronizando sua conta…", { exact: true })).toBeVisible();
  await expect(page.locator('img[src*="valurise-icon"]')).toBeVisible();
  await expect(page.getByText("Evolução financeira")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toMatch(/rgb\(18, 19, 26\)/);

  const mark = page.getByTestId("splash-mark");
  const logo = mark.locator("img");
  const markBox = await mark.boundingBox();
  const logoBox = await logo.boundingBox();
  expect(markBox).not.toBeNull();
  expect(logoBox).not.toBeNull();
  expect(logoBox!.width).toBeLessThanOrEqual(markBox!.width + 1);
  expect(logoBox!.height).toBeLessThanOrEqual(markBox!.height + 1);
  await expect.poll(() => logo.evaluate((element) => getComputedStyle(element.parentElement!).position)).toBe("absolute");
  for (const width of [375, 390, 430]) {
    await page.setViewportSize({ width, height: 844 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect.poll(() => mark.evaluate((element) => Math.round(element.getBoundingClientRect().width))).toBeGreaterThanOrEqual(144);
  }

  await expect(mark).toHaveAttribute("data-intro-complete", "true", { timeout: 2_000 });
  await expect.poll(() => page.getByTestId("splash-mark").locator("div").first().evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
  await expect(mark).toHaveAttribute("data-state", "revealing", { timeout: 10_000 });
  const revealStyles = await mark.evaluate((element) => {
    const root = element.parentElement?.parentElement;
    if (!root) throw new Error("Contêiner do splash não encontrado");
    const brandStyle = getComputedStyle(element.parentElement!);
    const overlayStyle = getComputedStyle(root, "::before");
    const markStyle = getComputedStyle(element);
    return {
      brandTransitionProperty: brandStyle.transitionProperty,
      brandTransitionDuration: brandStyle.transitionDuration,
      brandWillChange: brandStyle.willChange,
      overlayTransitionProperty: overlayStyle.transitionProperty,
      markTransitionProperty: markStyle.transitionProperty,
      markTransitionDuration: markStyle.transitionDuration,
    };
  });
  expect(revealStyles.brandTransitionProperty).toContain("opacity");
  expect(revealStyles.brandTransitionProperty).toContain("transform");
  expect(revealStyles.brandTransitionDuration).toContain("0.64s");
  expect(revealStyles.brandWillChange).toContain("opacity");
  expect(revealStyles.overlayTransitionProperty).toBe("opacity");
  expect(revealStyles.markTransitionProperty).toContain("transform");
  expect(revealStyles.markTransitionDuration).toContain("0.64s");
  await expect(page.getByRole("heading", { name: /^(Bom dia|Boa tarde|Boa noite), Pessoa de teste\.$/ })).toBeVisible({ timeout: 8_000 });
  await expect(page.getByText("Sincronizando sua conta…", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Mercado QA")).toBeVisible();
});

test("splash respeita movimento reduzido e libera o dashboard", async ({ page }) => {
  await installMockSession(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");

  await expect(page.getByRole("heading", { name: /^(Bom dia|Boa tarde|Boa noite), Pessoa de teste\.$/ })).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("falha temporária ao restaurar sessão libera a recuperação e o retorno ao login", async ({ page }) => {
  await installMockSession(page);
  await page.route("**/auth/v1/user", (route) => route.fulfill({ status: 503, json: { message: "Indisponível no teste" } }));
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Não foi possível validar seu acesso" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Tentar novamente" })).toBeVisible();
  await page.getByRole("button", { name: "Voltar ao login" }).click();
  await expect(page.getByRole("heading", { name: "Acesse sua conta" })).toBeVisible();
  await expect(page.getByText("Abrindo sua conta…", { exact: true })).toHaveCount(0);
});

test("splash libera o erro de sincronização em vez de permanecer carregando", async ({ page }) => {
  await installMockSession(page, 0, true);
  await page.goto("/");

  await expect(page.getByText("Não foi possível confirmar seus dados", { exact: true })).toBeVisible();
  await expect(page.getByText("Sincronizando sua conta…", { exact: true })).toHaveCount(0);
});

test("dashboard mantém conteúdo, sem overflow horizontal, em 375, 390 e 430 px", async ({ page }) => {
  await installMockSession(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /^(Bom dia|Boa tarde|Boa noite), Pessoa de teste\.$/ })).toBeVisible();
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

test("cabeçalho mantém seletor e ações utilizáveis em telas estreitas", async ({ page }) => {
  await installMockSession(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /^(Bom dia|Boa tarde|Boa noite), Pessoa de teste\.$/ })).toBeVisible({ timeout: 15_000 });

  const workspaceSwitcher = page.getByRole("button", { name: "Alternar espaço financeiro" });
  const header = workspaceSwitcher.locator("xpath=ancestor::header");
  const searchButton = page.getByRole("button", { name: "Buscar em todo o Valurise" });

  for (const width of [320, 360, 375, 390, 430, 768, 1023, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    const headerBounds = await header.boundingBox();
    const switcherBounds = await workspaceSwitcher.boundingBox();
    expect(headerBounds).not.toBeNull();
    expect(switcherBounds).not.toBeNull();
    expect(switcherBounds!.width).toBeGreaterThanOrEqual(70);
    expect(switcherBounds!.width).toBeLessThanOrEqual(160);

    const controls = await header.locator("button").evaluateAll((elements) => elements
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return { label: element.getAttribute("aria-label") || element.tagName, x: rect.x, right: rect.right, width: rect.width, height: rect.height, visible: style.display !== "none" && style.visibility !== "hidden" };
      })
      .filter((control) => control.visible && control.width > 0));

    for (const control of controls) {
      expect(control.x).toBeGreaterThanOrEqual(headerBounds!.x - 1);
      expect(control.right).toBeLessThanOrEqual(headerBounds!.x + headerBounds!.width + 1);
      if (control.label !== "Alternar espaço financeiro") expect(control.width).toBeGreaterThanOrEqual(44);
      if (control.label !== "Alternar espaço financeiro") expect(control.height).toBeGreaterThanOrEqual(44);
    }
    for (let index = 1; index < controls.length; index += 1) {
      expect(controls[index - 1].right).toBeLessThanOrEqual(controls[index].x + 1);
    }

    if (width < 1024) {
      await expect(searchButton).toBeHidden();
    } else {
      await expect(searchButton).toBeVisible();
      await expect(searchButton).toBeInViewport();
    }
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await workspaceSwitcher.focus();
  await page.keyboard.press("ArrowDown");
  const workspaceMenu = page.getByRole("menu", { name: "Espaços financeiros" });
  await expect(workspaceMenu).toBeVisible();
  const workspaceMenuBounds = await workspaceMenu.boundingBox();
  expect(workspaceMenuBounds).not.toBeNull();
  expect(workspaceMenuBounds!.x).toBeGreaterThanOrEqual(0);
  expect(workspaceMenuBounds!.x + workspaceMenuBounds!.width).toBeLessThanOrEqual(390);
  await page.keyboard.press("Escape");
  await expect(workspaceMenu).toBeHidden();
  await expect(workspaceSwitcher).toBeFocused();

  await page.getByRole("button", { name: "Abrir menu" }).click();
  const menu = page.getByRole("dialog", { name: "Menu principal" });
  await menu.getByRole("button", { name: "Buscar em todo o Valurise" }).click();
  await expect(page.getByPlaceholder("Ex.: gasolina, reserva, Nubank")).toBeVisible();
});

test("chat financeiro ocupa a tela inteira e mantém os atalhos responsivos", async ({ page }) => {
  await installMockSession(page);
  await page.goto("/");
  const movementShortcuts = ["Gastei", "Paguei", "Recebi", "Salário", "Investi", "Transferi"];

  for (const width of [375, 390, 430, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    const launcher = page.getByRole("button", { name: "Registrar movimentação" });
    const launcherBox = await launcher.boundingBox();
    const iconBox = await launcher.locator("svg").boundingBox();
    expect(launcherBox).not.toBeNull();
    expect(iconBox).not.toBeNull();
    if (width <= 430) {
      expect(Math.abs((iconBox!.x + iconBox!.width / 2) - (launcherBox!.x + launcherBox!.width / 2))).toBeLessThanOrEqual(1);
      expect(Math.abs((iconBox!.y + iconBox!.height / 2) - (launcherBox!.y + launcherBox!.height / 2))).toBeLessThanOrEqual(1);
    }

    await launcher.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Conversa com a Val")).toBeVisible();
    await expect(dialog.getByRole("textbox", { name: "Mensagem para a assistente financeira" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Enviar mensagem" })).toBeInViewport();
    const bounds = await dialog.boundingBox();
    const sheet = dialog.locator(":scope > section");
    const sheetBounds = await sheet.boundingBox();
    expect(bounds).not.toBeNull();
    expect(sheetBounds).not.toBeNull();
    expect(Math.abs(bounds!.width - width)).toBeLessThanOrEqual(1);
    expect(Math.abs(bounds!.height - 844)).toBeLessThanOrEqual(1);
    expect(Math.abs(sheetBounds!.height - 844)).toBeLessThanOrEqual(1);
    await expect(dialog.getByRole("button", { name: "Configurar IA", exact: true })).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Fechar", exact: true })).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Voltar ao painel" })).toBeVisible();
    const shortcutGroup = dialog.getByRole("group", { name: "Atalhos de movimentação" });
    const shortcutGroupBounds = await shortcutGroup.boundingBox();
    expect(shortcutGroupBounds).not.toBeNull();
    for (const label of movementShortcuts) {
      const shortcut = dialog.getByRole("button", { name: label, exact: true });
      await expect(shortcut).toBeVisible();
      const shortcutBounds = await shortcut.boundingBox();
      expect(shortcutBounds).not.toBeNull();
      expect(shortcutBounds!.x).toBeGreaterThanOrEqual(shortcutGroupBounds!.x - 1);
      expect(shortcutBounds!.x + shortcutBounds!.width).toBeLessThanOrEqual(shortcutGroupBounds!.x + shortcutGroupBounds!.width + 1);
      expect(shortcutBounds!.y + shortcutBounds!.height).toBeLessThanOrEqual(shortcutGroupBounds!.y + shortcutGroupBounds!.height + 1);
    }
    const messageAreaBounds = await dialog.locator('[aria-live="polite"]').boundingBox();
    const welcomeBounds = await dialog.getByText(/Olá! Eu sou a Val/).boundingBox();
    expect(messageAreaBounds).not.toBeNull();
    expect(welcomeBounds).not.toBeNull();
    expect(welcomeBounds!.width).toBeGreaterThanOrEqual(messageAreaBounds!.width * 0.96);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    if (width === 375) {
      await dialog.getByRole("button", { name: "Gastei", exact: true }).click();
      await expect(dialog.getByText("Quanto foi?", { exact: true })).toBeVisible();
      await dialog.getByRole("button", { name: "Fechar", exact: true }).click();
      continue;
    }

    await dialog.getByRole("button", { name: "Voltar ao painel" }).click();
    await expect(dialog).toHaveCount(0);
  }
});

test("respostas da Val são organizadas, sem Markdown cru e com poucos emojis", async ({ page }) => {
  await installMockSession(page);
  await page.route("**/api/personal-ai/connection", (route) => route.fulfill({ status: 200, json: {
    connection: { available: true, insights_enabled: true, actions_enabled: false, actions_allowed: true, consentRenewalRequired: false },
  } }));
  await page.route("**/api/personal-ai/chat", (route) => {
    if (route.request().method() === "GET") return route.fulfill({ status: 200, json: { messages: [
      { id: "legacy-question", role: "user", content: "O que a Val pode fazer?" },
      { id: "legacy-answer", role: "assistant", content: "**O que posso fazer:** - 📊 Mostrar resumos - 💳 Listar contas - 🧾 Ver faturas\n\n**Como funciona:** Não há gravações automáticas." },
    ] } });
    return route.fulfill({ status: 200, json: {
      reply: "Resposta objetiva.\n\n**Seu orçamento:** - Alimentação está em 68%. - Restam R$ 241,20.",
      usage: { totalTokens: 20 },
    } });
  });
  await page.route("**/api/personal-ai/actions", (route) => route.fulfill({ status: 200, json: { proposals: [] } }));

  await page.goto("/");
  await page.getByRole("button", { name: "Registrar movimentação" }).click();
  const dialog = page.getByRole("dialog");
  const messageArea = dialog.locator('[aria-live="polite"]');
  const oldReply = messageArea.locator(":scope > div").filter({ hasText: "O que posso fazer:" });
  await expect(oldReply).toContainText("• 📊 Mostrar resumos");
  await expect(oldReply).toContainText("• Listar contas");
  await expect(oldReply).not.toContainText("**");
  await expect(oldReply).not.toContainText("💳");
  await expect(oldReply).not.toContainText("🧾");
  await expect.poll(() => oldReply.evaluate((element) => getComputedStyle(element).whiteSpace)).toBe("pre-wrap");
  expect(await oldReply.innerText()).toContain("\n");

  await dialog.getByRole("textbox", { name: "Mensagem para a assistente financeira" }).fill("Como está meu orçamento?");
  await dialog.getByRole("button", { name: "Enviar mensagem" }).click();
  const newReply = messageArea.locator(":scope > div").filter({ hasText: "Seu orçamento:" });
  await expect(newReply).toContainText("• Alimentação está em 68%.");
  await expect(newReply).toContainText("• Restam R$ 241,20.");
  await expect(newReply).not.toContainText("**");
  expect(await newReply.innerText()).toContain("\n");
  for (const width of [375, 390, 430]) {
    await page.setViewportSize({ width, height: 844 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(dialog.getByRole("button", { name: "Enviar mensagem" })).toBeInViewport();
  }
});

test("alertas podem ser dispensados e saem do sino", async ({ page }) => {
  await installMockSession(page);
  await page.goto("/");
  const bell = page.getByRole("button", { name: /Abrir notificações \(\d+\)/ });
  await expect(bell).toBeVisible();
  await bell.click();
  const notifications = page.getByRole("region", { name: "Notificações financeiras" });
  await expect(notifications.getByText("Alimentação chegou a 80%")).toBeVisible();
  await notifications.getByRole("button", { name: "Dispensar Alimentação chegou a 80%" }).click();
  await expect(notifications.getByText("Alimentação chegou a 80%")).toHaveCount(0);
  await notifications.getByRole("button", { name: "Dispensar todos" }).click();
  await expect(notifications.getByText("Tudo em dia")).toBeVisible();
  await expect(page.getByRole("button", { name: "Abrir notificações" })).toBeVisible();
});

test("a área comum da Val não expõe providers, modelos técnicos nem configuração de chaves", async ({ page }) => {
  await installMockSession(page);
  let savedPreference: Record<string, unknown> | null = null;
  await page.route("**/api/personal-ai/connection", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ status: 200, json: { connection: {
      available: true, insights_enabled: false, actions_enabled: false, actions_allowed: true, consentRenewalRequired: false,
    } } });
    savedPreference = route.request().postDataJSON() as Record<string, unknown>;
    const enabled = savedPreference.insightsEnabled === true;
    return route.fulfill({ status: 200, json: { ok: true, pendingProposalsCancelled: false, connection: {
      available: true, insights_enabled: enabled, actions_enabled: enabled && savedPreference.actionsEnabled === true, actions_allowed: true, consentRenewalRequired: false,
    } } });
  });
  await page.route("**/api/personal-ai/usage", (route) => route.fulfill({ status: 200, json: {
    available: true, usage: { today: { requests: 2, limit: 10, remaining: 8 }, month: { requests: 7, limit: 200, remaining: 193, tokens: 840 } },
  } }));

  await page.goto("/");
  await page.getByRole("button", { name: "Configurações", exact: true }).click();
  await expect(page.getByText("Val · sua assistente financeira")).toBeVisible();
  await expect(page.getByText("8 de 10 consultas disponíveis")).toBeVisible();
  await expect(page.getByLabel("Provedor", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("API key")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Testar conexão" })).toHaveCount(0);
  await expect(page.getByLabel("Permitir que a Val consulte meus dados financeiros")).toBeVisible();
  await expect(page.getByLabel("Permitir propostas de receitas e despesas")).toBeDisabled();

  await page.getByLabel("Permitir que a Val consulte meus dados financeiros").check();
  await page.getByLabel("Permitir propostas de receitas e despesas").check();
  await page.getByRole("button", { name: "Salvar preferências" }).click();
  await expect.poll(() => savedPreference).toMatchObject({ insightsEnabled: true, actionsEnabled: true });

  const visiblePageText = await page.locator("body").innerText();
  expect(visiblePageText).not.toContain("Groq");
  expect(visiblePageText).not.toContain("OpenRouter");
  expect(visiblePageText).not.toContain("openrouter/free");
  expect(JSON.stringify(await page.evaluate(() => localStorage))).not.toContain("apiKey");
  for (const width of [375, 390, 430, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
});

test("erros internos dos providers não são expostos para a pessoa usuária", async ({ page }) => {
  await installMockSession(page);
  await page.route("**/api/personal-ai/connection", (route) => route.fulfill({ status: 200, json: {
    connection: { available: true, insights_enabled: false, actions_enabled: false, actions_allowed: true, consentRenewalRequired: false },
  } }));
  await page.route("**/api/personal-ai/chat", (route) => {
    if (route.request().method() === "GET") return route.fulfill({ status: 200, json: { messages: [] } });
    return route.fulfill({ status: 503, json: {
      error: "A Val está temporariamente indisponível. Tente novamente em alguns instantes.",
      category: "RATE_LIMITED", provider: "groq", model: "private-model-id", providerCode: "SECRET_PROVIDER_DETAIL",
    } });
  });
  await page.route("**/api/personal-ai/actions", (route) => route.fulfill({ status: 200, json: { proposals: [] } }));

  await page.goto("/");
  await page.getByRole("button", { name: "Registrar movimentação" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Mensagem para a assistente financeira" }).fill("Me ajude a entender meus gastos");
  await dialog.getByRole("button", { name: "Enviar mensagem" }).click();
  const userError = dialog.getByRole("alert");
  await expect(userError).toHaveText("A Val está temporariamente indisponível. Tente novamente em alguns instantes.");
  await expect(userError).not.toContainText("Groq");
  await expect(userError).not.toContainText("OpenRouter");
  await expect(userError).not.toContainText("RATE_LIMITED");
  await expect(userError).not.toContainText("SECRET_PROVIDER_DETAIL");
  await expect(userError).not.toContainText("private-model-id");
});

test("a Val só registra receita ou despesa depois da aprovação explícita da proposta", async ({ page }) => {
  await installMockSession(page);
  const decisions: Array<{ proposalId: string; decision: string }> = [];
  await page.route("**/api/personal-ai/connection", (route) => route.fulfill({ status: 200, json: {
    connection: { available: true, insights_enabled: true, actions_enabled: true, actions_allowed: true, consentRenewalRequired: false },
  } }));
  await page.route("**/api/personal-ai/actions", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ status: 200, json: { proposals: [] } });
    const body = route.request().postDataJSON();
    decisions.push(body);
    return route.fulfill({ status: 200, json: body.decision === "approve"
      ? { ok: true, version: 2, transaction: { id: "created-after-approval" } }
      : { ok: true, decision: "rejected" } });
  });
  await page.route("**/api/personal-ai/chat", (route) => {
    if (route.request().method() === "GET") return route.fulfill({ status: 200, json: { messages: [] } });
    return route.fulfill({ status: 200, json: {
      reply: "Preparei uma proposta de despesa. Confira e confirme.",
      proposals: [{
        id: "22222222-2222-4222-8222-222222222222", action_type: "expense", amount_cents: 1290,
        category: "Alimentação", account_label: "Banco de teste • Conta principal", description: "Almoço",
        transaction_date: currentMonth + "-15", expires_at: new Date(Date.now() + 600_000).toISOString(),
      }], usage: { totalTokens: 20 },
    } });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Registrar movimentação" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Mensagem para a assistente financeira" }).fill("Registre meu gasto de almoço de R$ 12,90 hoje");
  await dialog.getByRole("button", { name: "Enviar mensagem" }).click();
  await expect(dialog.getByText("Revisar proposta da Val")).toBeVisible();
  await expect(dialog.getByText("Banco de teste • Conta principal")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Confirmar e registrar despesa" })).toBeVisible();
  expect(decisions).toHaveLength(0);
  for (const width of [375, 390, 430]) {
    await page.setViewportSize({ width, height: 844 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await dialog.getByRole("button", { name: "Confirmar e registrar despesa" }).scrollIntoViewIfNeeded();
    await expect(dialog.getByRole("button", { name: "Confirmar e registrar despesa" })).toBeInViewport();
  }

  await dialog.getByRole("button", { name: "Confirmar e registrar despesa" }).click();
  await expect(page.getByText("Lançamento confirmado e sincronizado.")).toBeVisible();
  await expect(dialog.getByText("Revisar proposta da Val")).toHaveCount(0);
  expect(decisions.at(-1)).toMatchObject({ decision: "approve" });

  await dialog.getByRole("textbox", { name: "Mensagem para a assistente financeira" }).fill("Registre meu gasto de almoço de R$ 12,90 hoje");
  await dialog.getByRole("button", { name: "Enviar mensagem" }).click();
  await expect(dialog.getByText("Revisar proposta da Val")).toBeVisible();
  await dialog.getByRole("button", { name: "Descartar" }).click();
  await expect(dialog.getByText("Proposta descartada. Nenhum lançamento foi criado.")).toBeVisible();
  expect(decisions.at(-1)).toMatchObject({ decision: "reject" });
});

test("ao abrir um alerta, ele é marcado como visto e some do sino", async ({ page }) => {
  await installMockSession(page);
  await page.goto("/");
  const bell = page.getByRole("button", { name: /Abrir notificações \(\d+\)/ });
  await bell.click();
  const notifications = page.getByRole("region", { name: "Notificações financeiras" });
  await notifications.getByRole("button", { name: /Restam R\$/ }).click();
  await expect(page.getByRole("heading", { name: "Orçamentos" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Abrir notificações" })).toBeVisible();
});

test("orçamento só aceita categorias existentes e não cria duplicidade no mesmo mês", async ({ page }) => {
  await installMockSession(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Orçamentos", exact: true }).click();
  await page.getByRole("button", { name: "Adicionar orçamento" }).click();

  const category = page.getByRole("combobox", { name: "Categoria do orçamento" });
  await expect(category.locator("option")).toHaveText([
    "Selecione uma categoria", "Alimentação", "Moradia", "Transporte",
  ]);
  await expect(page.getByPlaceholder("Categoria que você quer controlar")).toHaveCount(0);
  await category.selectOption("Alimentação");
  await page.getByLabel("Limite mensal").fill("750,00");
  await page.getByRole("button", { name: "Criar orçamento" }).click();
  await expect(page.getByText("Já existe um orçamento desta categoria neste mês.")).toBeVisible();
  await expect(category).toBeVisible();

  await category.selectOption("Transporte");
  await page.getByRole("button", { name: "Criar orçamento" }).click();
  await expect(page.getByText("Orçamento criado com sucesso.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Orçamentos" })).toBeVisible();
  await expect(page.getByText("Transporte", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Categorias", exact: true }).click();
  await page.getByRole("button", { name: "Excluir categoria Alimentação" }).click();
  await page.getByRole("button", { name: "Excluir", exact: true }).last().click();
  await expect(page.getByText("Mova ou exclua o orçamento vinculado antes de remover esta categoria.")).toBeVisible();
  await expect(page.getByText("Alimentação", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Orçamentos", exact: true }).click();
  await expect(page.getByText("Alimentação", { exact: true }).first()).toBeVisible();
});

test("navegação, formulários e controles mantêm dimensões em desktop e mobile", async ({ page }) => {
  test.setTimeout(120_000);
  await installMockSession(page);
  await page.goto("/");

  for (const width of [1280, 375, 390, 430]) {
    await page.setViewportSize({ width, height: 844 });
      const mobile = width < 1024;
      for (const view of ["Dashboard", "Extrato", "Contas", "Cartões", "Investimentos", "Orçamentos", "Metas", "Receitas", "Planejamento", "Relatórios", "Categorias", "Configurações"]) {
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
        const institution = page.getByTestId("institution-card").first();
        await expect(institution.getByText("Banco de teste", { exact: true })).toBeVisible();
        await expect(institution.locator("[data-finance-icon]")).toHaveCount(1);
        const accountRows = institution.getByTestId("institution-account-row");
        await expect(accountRows).toHaveCount(2);
        await expect(accountRows.getByText("Conta principal", { exact: true })).toBeVisible();
        await expect(accountRows.getByText("Conta destino", { exact: true })).toBeVisible();
        await expect(accountRows.locator("[data-finance-icon]")).toHaveCount(0);

        const addButton = page.getByRole("button", { name: "Adicionar conta ou instituição" });
        await expect(addButton).toBeVisible();
        await addButton.click();
        const fieldHeights = await page.locator(".field").evaluateAll((elements) => elements.map((element) => (element as HTMLElement).offsetHeight));
        expect(fieldHeights.length).toBeGreaterThan(0);
        expect(fieldHeights.every((height) => height === 48), JSON.stringify(fieldHeights)).toBe(true);
        await page.getByRole("button", { name: "Fechar" }).click();
      }

      if (view === "Configurações") {
        const checkboxes = page.getByRole("checkbox");
        await expect(checkboxes).toHaveCount(2);
        const checkboxSizes = await checkboxes.evaluateAll((elements) => elements.map((element) => {
          const { width, height } = element.getBoundingClientRect();
          return { width, height };
        }));
        expect(checkboxSizes.length).toBe(2);
        expect(checkboxSizes.every((checkbox) => Math.abs(checkbox.width - 18) < 0.1 && Math.abs(checkbox.height - 18) < 0.1), JSON.stringify(checkboxSizes)).toBe(true);
      }

      if (view === "Planejamento") {
        await expect(page.getByText("Calendário financeiro", { exact: true })).toBeVisible();
        await expect(page.getByRole("button", { name: "Mês anterior" })).toBeVisible();
        await expect(page.getByRole("button", { name: "Próximo mês" })).toBeVisible();
      }
    }

    const headerButtons = await page.locator("header button[aria-label]").evaluateAll((elements) => elements.filter((element) => element.getClientRects().length > 0).map((element) => {
      const { width: buttonWidth, height } = element.getBoundingClientRect();
      return { label: element.getAttribute("aria-label"), width: buttonWidth, height };
    }).filter((button) => button.label !== "Alternar espaço financeiro"));
    expect(headerButtons.length).toBeGreaterThan(0);
    expect(headerButtons.every((button) => button.width === 44 && button.height === 44), JSON.stringify(headerButtons)).toBe(true);
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

  const transactions = await page.evaluate((storageKey) => JSON.parse(localStorage.getItem(storageKey) || "[]"), `valurise:v2:${testUserId}:workspace:${personalWorkspaceId}:tx`);
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
  await page.getByRole("button", { name: "Adicionar compromisso" }).click();

  await page.getByPlaceholder("Ex.: Internet, aluguel, Netflix").fill("Internet QA");
  await page.getByPlaceholder("Valor previsto").fill("89,90");
  await page.getByPlaceholder("Dia de vencimento").fill("28");
  await page.getByPlaceholder("Categoria (opcional)").fill("Moradia");
  await page.getByLabel("Repetição", { exact: true }).selectOption("monthly");
  await page.getByRole("button", { name: "Adicionar ao planejamento" }).click();
  await expect(page.getByText("Internet QA", { exact: false }).first()).toBeVisible();

  await page.getByRole("button", { name: new RegExp(`28 de .*1 vencimento`) }).click();
  await page.getByRole("button", { name: "Marcar paga" }).click();

  await page.getByRole("button", { name: "Editar a conta recorrente Internet QA" }).click();
  await page.getByPlaceholder("Ex.: Internet, aluguel, Netflix").fill("Internet QA editada");
  await page.getByPlaceholder("Valor previsto").fill("99,90");
  await page.getByRole("button", { name: "Salvar alterações" }).click();
  await expect(page.getByRole("button", { name: "Excluir a conta recorrente Internet QA editada" })).toBeVisible();

  await page.getByRole("button", { name: "Próximo mês" }).click();
  await page.getByRole("button", { name: new RegExp(`28 de .*1 vencimento`) }).click();
  await expect(page.getByRole("button", { name: "Marcar paga" })).toBeVisible();
  await page.getByRole("button", { name: "Marcar paga" }).click();
  await page.getByRole("button", { name: "Mês anterior" }).click();
  await page.getByRole("button", { name: new RegExp(`28 de .*1 vencimento`) }).click();
  await expect(page.getByRole("button", { name: "Desfazer" })).toBeVisible();

  await page.getByRole("button", { name: "Próximo mês" }).click();
  await page.getByRole("button", { name: "Adicionar compromisso" }).click();
  await page.getByPlaceholder("Ex.: Internet, aluguel, Netflix").fill("Seguro QA avulso");
  await page.getByPlaceholder("Valor previsto").fill("50,00");
  await page.getByPlaceholder("Dia de vencimento").fill("15");
  await page.getByLabel("Repetição", { exact: true }).selectOption("once");
  await page.getByRole("button", { name: "Adicionar ao planejamento" }).click();
  await expect(page.getByText("Seguro QA avulso", { exact: false }).first()).toBeVisible();
  await page.getByRole("button", { name: "Próximo mês" }).click();
  await expect(page.getByText("Seguro QA avulso", { exact: false })).toHaveCount(0);
  await page.getByRole("button", { name: "Mês anterior" }).click();

  await page.getByRole("button", { name: "Excluir a conta recorrente Internet QA editada" }).click();
  await page.getByRole("button", { name: "Excluir", exact: true }).click();
  await expect(page.getByText("Internet QA editada", { exact: false })).toHaveCount(0);
  await page.getByRole("button", { name: "Excluir a conta recorrente Seguro QA avulso" }).click();
  await page.getByRole("button", { name: "Excluir", exact: true }).click();

  const savedData = await page.evaluate((storageKey) => JSON.parse(localStorage.getItem(storageKey) || "{}"), `valurise:v2:${testUserId}:workspace:${personalWorkspaceId}:data`);
  expect(savedData.recurringBills).toEqual([]);
});

test("backup JSON substitui somente dados financeiros após confirmação", async ({ page }) => {
  await installMockSession(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Configurações" }).click();

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

  const storagePrefix = `valurise:v2:${testUserId}:workspace:${personalWorkspaceId}`;
  const savedData = await page.evaluate((key) => JSON.parse(localStorage.getItem(`${key}:data`) || "{}"), storagePrefix);
  const savedTransactions = await page.evaluate((key) => JSON.parse(localStorage.getItem(`${key}:tx`) || "[]"), storagePrefix);
  expect(savedData.categories).toEqual(["Importada QA"]);
  expect(savedTransactions).toHaveLength(1);
  expect(savedTransactions[0]).toMatchObject({ id: "backup-transaction-qa", amountCents: 1234 });
  await expect(page.getByText("Backup restaurado e sincronização iniciada.")).toBeVisible();
});
