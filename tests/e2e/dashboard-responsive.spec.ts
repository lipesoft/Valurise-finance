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
      const state = requestedWorkspace === businessWorkspaceId ? {
        data: { categories: [], institutions: [], onboarded: false },
        transactions: [],
        profile: {},
      } : mockState;
      return route.fulfill({ status: 200, json: { state, version: 1 } });
    }
    if (pathname.endsWith("/user_consents")) {
      return route.fulfill({ status: 200, json: { cookie_preference: "essential_only", cookie_policy_version: "2026-09-23-v1" } });
    }
    return route.fulfill({ status: 200, json: [] });
  });
  await page.route("**/api/personal-ai/connection", (route) => {
    if (route.request().method() === "GET") return route.fulfill({ status: 200, json: { connection: null } });
    return route.fulfill({ status: 200, json: { ok: true } });
  });
  await page.route("**/api/personal-ai/usage", (route) => route.fulfill({ status: 200, json: {
    available: true,
    usage: { requests: 2, chatRequests: 1, inputTokens: 100, outputTokens: 40, totalTokens: 140, quotaTokens: null },
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
  await installMockSession(page);
  await page.goto("/");
  await expect(page.getByText("Mercado QA")).toBeVisible();
  await page.getByRole("button", { name: "Criar espaço empresarial" }).click();
  const dialog = page.getByRole("dialog", { name: "Criar espaço empresarial" });
  await dialog.getByLabel("Nome fantasia").fill("Empresa QA");
  await dialog.getByLabel("Razão social").fill("Empresa QA Serviços LTDA");
  await dialog.getByLabel("CNPJ").fill("11.222.333/0001-81");
  await dialog.getByRole("button", { name: "Criar empresa" }).click();

  await expect(page.getByRole("heading", { name: "Empresa QA", exact: true })).toBeVisible();
  await expect(page.getByText("Mercado QA")).toHaveCount(0);
  await page.getByRole("button", { name: "Continuar depois" }).click();
  await expect(page.getByRole("button", { name: "Registrar movimentação" })).toBeVisible();

  await page.getByLabel("Espaço financeiro ativo").selectOption(personalWorkspaceId);
  await expect(page.getByText("Mercado QA")).toBeVisible();
  await page.getByLabel("Espaço financeiro ativo").selectOption(businessWorkspaceId);
  await expect(page.getByText("Mercado QA")).toHaveCount(0);
});

test("splash acompanha a sincronização real e revela a interface pelo símbolo", async ({ page }) => {
  await installMockSession(page, 4000);
  await page.setViewportSize({ width: 375, height: 844 });
  await page.goto("/");

  await expect(page.getByText("Sincronizando sua conta…", { exact: true })).toBeVisible();
  await expect(page.locator('img[src*="valurise-icon"]')).toBeVisible();
  await expect(page.getByText("Evolução financeira")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toMatch(/rgb\(18, 19, 26\)/);

  for (const width of [375, 390, 430]) {
    await page.setViewportSize({ width, height: 844 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }

  const revealMask = page.getByTestId("splash-reveal-mask");
  await expect(revealMask).toHaveAttribute("data-intro-complete", "true", { timeout: 2_000 });
  await expect.poll(() => page.getByTestId("splash-mark").locator("div").first().evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
  await expect(revealMask).toHaveAttribute("data-state", "revealing", { timeout: 10_000 });
  await expect(revealMask).toHaveCSS("transition-property", "transform");
  await expect(revealMask).toHaveCSS("will-change", "transform");
  await expect(revealMask.locator("mask")).toHaveCount(1);
  await expect(revealMask.locator("image")).toHaveAttribute("href", "/valurise-icon.webp");
  await expect(page.getByRole("heading", { name: /^(Bom dia|Boa tarde|Boa noite), Pessoa de teste\.$/ })).toBeVisible({ timeout: 8_000 });
  await expect(page.getByText("Sincronizando sua conta…", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Mercado QA")).toBeVisible();
});

test("splash respeita movimento reduzido e libera o dashboard", async ({ page }) => {
  await installMockSession(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");

  await expect(page.getByRole("heading", { name: /^(Bom dia|Boa tarde|Boa noite), Pessoa de teste\.$/ })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("splash libera o login quando a restauração da sessão falha", async ({ page }) => {
  await installMockSession(page);
  await page.route("**/auth/v1/user", (route) => route.fulfill({ status: 503, json: { message: "Indisponível no teste" } }));
  await page.goto("/");

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
    connection: { provider: "openrouter", model: "openrouter/free", insights_enabled: true, actions_enabled: false, validated: true, validated_model: "openrouter/free", validated_at: "2026-09-24T12:00:00.000Z" },
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

test("configura a Val com modelos Gemini confirmados, diagnóstico de erro e teste mínimo sem persistir a chave no navegador", async ({ page }) => {
  await installMockSession(page);
  let savedConnection: Record<string, unknown> | null = null;
  await page.route("**/api/personal-ai/connection", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ status: 200, json: { connection: null } });
    const body = route.request().postDataJSON() as Record<string, unknown>;
    savedConnection = body;
    return route.fulfill({ status: 200, json: { ok: true, validated: !Object.hasOwn(body, "apiKey"), validatedAt: "2026-09-24T12:00:00.000Z" } });
  });
  const testedModels: string[] = [];
  await page.route("**/api/personal-ai/test", async (route) => {
    const body = route.request().postDataJSON() as { model: string };
    testedModels.push(body.model);
    if (testedModels.length === 1) return route.fulfill({ status: 502, json: {
      error: "A chave da Gemini não tem permissão para usar esta API ou modelo.", category: "PERMISSION_DENIED",
      providerMessage: "Gemini API has not been enabled for this project.", providerCode: "SERVICE_DISABLED", providerHttpStatus: 403, model: body.model,
    } });
    return route.fulfill({ status: 200, json: {
      ok: true, provider: "gemini", model: body.model, latencyMs: 842,
      validated: Boolean(savedConnection), validatedAt: "2026-09-24T12:00:00.000Z",
      usage: { inputTokens: 3, outputTokens: 1 },
    } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Ajustes", exact: true }).click();
  await expect(page.getByText("Val · assistente financeira")).toBeVisible();
  const actionPermission = page.getByLabel("Permitir propostas de receitas e despesas com confirmação obrigatória");
  await expect(actionPermission).toBeDisabled();
  await page.locator("label").filter({ hasText: "Compartilhar dados para análise financeira" }).click();
  await expect(actionPermission).toBeEnabled();
  await page.locator("label").filter({ hasText: "Permitir ações financeiras com confirmação" }).click();
  await expect(actionPermission).toBeChecked();
  await page.getByLabel("Provedor").selectOption("gemini");
  await page.getByLabel("API key").fill("e2e-chave-ficticia-sem-uso-real");
  const geminiModel = page.getByLabel("Modelo Gemini");
  await expect(geminiModel).toBeVisible();
  await expect(geminiModel.locator("option")).toHaveCount(2);
  await expect(geminiModel).toHaveValue("gemini-2.5-flash-lite");
  await page.getByRole("button", { name: "Testar conexão" }).click();
  const providerError = page.getByRole("status").filter({ hasText: "Permissão negada" });
  await expect(providerError).toContainText("gemini-2.5-flash-lite");
  await expect(providerError).toContainText("HTTP do provedor: 403");
  await expect(providerError).toContainText("SERVICE_DISABLED");
  await expect(providerError).toContainText("Gemini API has not been enabled for this project.");
  await geminiModel.selectOption("gemini-2.5-flash");
  await page.getByRole("button", { name: "Testar conexão" }).click();
  await expect(page.getByRole("status").filter({ hasText: "ainda não está salvo" })).toContainText("gemini-2.5-flash");
  await expect(page.getByRole("button", { name: "Conectar Val" })).toBeVisible();
  await page.getByRole("button", { name: "Conectar Val" }).click();
  await expect.poll(() => savedConnection).toMatchObject({ insightsEnabled: true, actionsEnabled: true });
  await page.getByRole("button", { name: "Testar conexão" }).click();
  await expect(page.getByRole("status").filter({ hasText: "842 ms" })).toContainText("Conexão validada com gemini-2.5-flash · 842 ms");
  expect(testedModels).toEqual(["gemini-2.5-flash-lite", "gemini-2.5-flash", "gemini-2.5-flash"]);
  await expect(page.getByText("Solicitações")).toBeVisible();
  await expect(page.getByText("140", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Salvar configuração" }).click();
  await expect.poll(() => savedConnection).toMatchObject({ insightsEnabled: true, actionsEnabled: true });
  await page.locator("label").filter({ hasText: "Compartilhar dados para análise financeira" }).click();
  await expect(actionPermission).toBeDisabled();
  await expect(actionPermission).not.toBeChecked();
  const localStorageValue = await page.evaluate(() => JSON.stringify(localStorage));
  expect(localStorageValue).not.toContain("e2e-chave-ficticia-sem-uso-real");
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("configura Groq e OpenRouter com catálogos mockados, modelo gratuito priorizado e chaves fora do navegador", async ({ page }) => {
  await installMockSession(page);
  let savedConnection: Record<string, unknown> | null = null;
  const catalogProviders: string[] = [];
  const testedConfigs: Array<{ provider: string; model: string; includedApiKey: boolean }> = [];

  await page.route("**/api/personal-ai/connection", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ status: 200, json: { connection: null } });
    savedConnection = route.request().postDataJSON() as Record<string, unknown>;
    return route.fulfill({ status: 200, json: { ok: true, validated: false, validatedAt: null } });
  });
  await page.route("**/api/personal-ai/models", async (route) => {
    const body = route.request().postDataJSON() as { provider: string };
    catalogProviders.push(body.provider);
    const models = body.provider === "groq"
      ? [
        { id: "openai/gpt-oss-20b", label: "openai/gpt-oss-20b", tier: "recommended", provider: "groq" },
        { id: "qwen/qwen3-32b", label: "qwen/qwen3-32b", tier: "other", provider: "groq" },
      ]
      : [
        { id: "openrouter/free", label: "OpenRouter Free · Recomendado", tier: "recommended", free: true, provider: "openrouter" },
        { id: "qwen/model:free", label: "Qwen Free", tier: "economical", free: true, provider: "openrouter" },
        { id: "paid/provider-model", label: "Paid provider model", tier: "other", free: false, provider: "openrouter" },
      ];
    return route.fulfill({ status: 200, json: { provider: body.provider, models } });
  });
  await page.route("**/api/personal-ai/test", async (route) => {
    const body = route.request().postDataJSON() as { provider: string; model: string; apiKey?: string };
    testedConfigs.push({ provider: body.provider, model: body.model, includedApiKey: Object.hasOwn(body, "apiKey") });
    const matchesSaved = Boolean(savedConnection
      && savedConnection.provider === body.provider
      && savedConnection.model === body.model
      && !Object.hasOwn(body, "apiKey"));
    return route.fulfill({ status: 200, json: {
      ok: true,
      provider: body.provider,
      model: body.model,
      latencyMs: 120,
      validated: matchesSaved,
      validatedAt: matchesSaved ? "2026-09-25T12:00:00.000Z" : null,
      toolCallingValidated: body.provider === "groq" || body.provider === "openrouter",
      usage: { inputTokens: null, outputTokens: null },
    } });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Ajustes", exact: true }).click();
  await expect(page.getByText("Val · assistente financeira")).toBeVisible();
  const providerSelect = page.getByLabel("Provedor");
  await expect(providerSelect.locator("option")).toHaveText(["OpenAI", "Gemini", "DeepSeek", "Groq", "OpenRouter"]);
  const apiKeyInput = page.getByLabel("API key");

  for (const width of [375, 390, 430, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }

  await providerSelect.selectOption("groq");
  await apiKeyInput.fill("e2e-groq-fake-key-never-valid-0001");
  await page.getByRole("button", { name: "Atualizar modelos disponíveis" }).click();
  const modelSelect = page.getByLabel("Modelos disponíveis para esta chave");
  await expect(modelSelect.locator("option").first()).toHaveValue("openai/gpt-oss-20b");
  await expect(modelSelect).toHaveValue("openai/gpt-oss-20b");
  await modelSelect.selectOption("qwen/qwen3-32b");
  await page.getByRole("button", { name: "Testar conexão" }).click();
  await expect(page.getByRole("status").filter({ hasText: "ainda não está salvo" })).toContainText("qwen/qwen3-32b");
  await page.getByRole("button", { name: "Conectar Val" }).click();
  await expect.poll(() => savedConnection).toMatchObject({ provider: "groq", model: "qwen/qwen3-32b" });
  await expect(apiKeyInput).toHaveValue("");
  await page.getByRole("button", { name: "Testar conexão" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Conexão validada com qwen/qwen3-32b" })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Conexão validada com qwen/qwen3-32b" })).toContainText("ferramentas da Val confirmadas");

  await providerSelect.selectOption("openrouter");
  await apiKeyInput.fill("e2e-openrouter-fake-key-never-valid-0002");
  await page.getByRole("button", { name: "Atualizar modelos disponíveis" }).click();
  const openRouterModelSelect = page.getByLabel("Modelos disponíveis para esta chave");
  await expect(openRouterModelSelect.locator("option").first()).toHaveValue("openrouter/free");
  await expect(openRouterModelSelect.locator("option").nth(0)).toContainText("OpenRouter Free · Recomendado");
  await expect(openRouterModelSelect.locator("option").nth(1)).toContainText("Gratuito");
  await expect(openRouterModelSelect.locator("option").nth(2)).toContainText("Paid provider model");
  await openRouterModelSelect.selectOption("qwen/model:free");
  await page.getByRole("button", { name: "Testar conexão" }).click();
  await expect(page.getByRole("status").filter({ hasText: "ainda não está salvo" })).toContainText("qwen/model:free");
  await page.getByRole("button", { name: "Salvar configuração" }).click();
  await expect.poll(() => savedConnection).toMatchObject({ provider: "openrouter", model: "qwen/model:free" });
  await expect(apiKeyInput).toHaveValue("");
  await page.getByRole("button", { name: "Testar conexão" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Conexão validada com qwen/model:free" })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Conexão validada com qwen/model:free" })).toContainText("ferramentas da Val confirmadas");

  expect(catalogProviders).toEqual(["groq", "openrouter"]);
  expect(testedConfigs).toEqual([
    { provider: "groq", model: "qwen/qwen3-32b", includedApiKey: true },
    { provider: "groq", model: "qwen/qwen3-32b", includedApiKey: false },
    { provider: "openrouter", model: "qwen/model:free", includedApiKey: true },
    { provider: "openrouter", model: "qwen/model:free", includedApiKey: false },
  ]);
  const browserStorage = await page.evaluate(() => JSON.stringify(localStorage));
  const visiblePageText = await page.locator("body").innerText();
  expect(browserStorage).not.toContain("e2e-groq-fake-key-never-valid-0001");
  expect(browserStorage).not.toContain("e2e-openrouter-fake-key-never-valid-0002");
  expect(visiblePageText).not.toContain("e2e-groq-fake-key-never-valid-0001");
  expect(visiblePageText).not.toContain("e2e-openrouter-fake-key-never-valid-0002");
});

test("chat mostra o diagnóstico devolvido pelo provedor Gemini", async ({ page }) => {
  await installMockSession(page);
  await page.route("**/api/personal-ai/connection", (route) => route.fulfill({ status: 200, json: {
    connection: { provider: "gemini", model: "gemini-2.5-flash-lite", insights_enabled: true, actions_enabled: false, validated: true, validated_model: "gemini-2.5-flash-lite", validated_at: "2026-09-24T12:00:00.000Z" },
  } }));
  await page.route("**/api/personal-ai/chat", (route) => {
    if (route.request().method() === "GET") return route.fulfill({ status: 200, json: { messages: [] } });
    return route.fulfill({ status: 502, json: {
      error: "A chave da Gemini não tem permissão para usar esta API ou este modelo.", category: "PERMISSION_DENIED",
      providerMessage: "Gemini API has not been enabled for this project.", providerCode: "SERVICE_DISABLED", providerHttpStatus: 403,
      model: "gemini-2.5-flash-lite", requestId: "google-request-test-1",
    } });
  });
  await page.route("**/api/personal-ai/actions", (route) => route.fulfill({ status: 200, json: { proposals: [] } }));

  await page.goto("/");
  await page.getByRole("button", { name: "Registrar movimentação" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Mensagem para a assistente financeira" }).fill("Me ajude a entender meus gastos");
  await dialog.getByRole("button", { name: "Enviar mensagem" }).click();
  const providerError = dialog.getByRole("alert");
  await expect(providerError).toContainText("Permissão negada");
  await expect(providerError).toContainText("gemini-2.5-flash-lite");
  await expect(providerError).toContainText("HTTP do provedor: 403");
  await expect(providerError).toContainText("SERVICE_DISABLED");
  await expect(providerError).toContainText("Gemini API has not been enabled for this project.");
});

test("a Val só registra receita ou despesa depois da aprovação explícita da proposta", async ({ page }) => {
  await installMockSession(page);
  const decisions: Array<{ proposalId: string; decision: string }> = [];
  await page.route("**/api/personal-ai/connection", (route) => route.fulfill({ status: 200, json: {
    connection: { provider: "openai", model: "gpt-test", insights_enabled: true, actions_enabled: true, validated: true, validated_model: "gpt-test", validated_at: "2026-09-24T12:00:00.000Z" },
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

test("navegação, formulários e controles mantêm dimensões em desktop e mobile", async ({ page }) => {
  test.setTimeout(120_000);
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
        const checkboxes = page.getByRole("checkbox");
        await expect(checkboxes).toHaveCount(3);
        const checkboxSizes = await checkboxes.evaluateAll((elements) => elements.map((element) => {
          const indicator = element.closest("label")?.querySelector('[aria-hidden="true"]') as HTMLElement | null;
          const { width, height } = indicator?.getBoundingClientRect() || { width: 0, height: 0 };
          return { width, height, hiddenInput: (element as HTMLInputElement).classList.contains("sr-only") };
        }));
        expect(checkboxSizes.length).toBeGreaterThanOrEqual(3);
        expect(checkboxSizes.every((checkbox) => Math.abs(checkbox.width - 32) < 0.1 && Math.abs(checkbox.height - 32) < 0.1 && checkbox.hiddenInput), JSON.stringify(checkboxSizes)).toBe(true);
      }

      if (view === "Planejamento") {
        await expect(page.getByText("Calendário financeiro", { exact: true })).toBeVisible();
        await expect(page.getByRole("button", { name: "Mês anterior" })).toBeVisible();
        await expect(page.getByRole("button", { name: "Próximo mês" })).toBeVisible();
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
  await page.getByLabel("Repetição").selectOption("monthly");
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
  await page.getByLabel("Repetição").selectOption("once");
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

  const storagePrefix = `valurise:v2:${testUserId}:workspace:${personalWorkspaceId}`;
  const savedData = await page.evaluate((key) => JSON.parse(localStorage.getItem(`${key}:data`) || "{}"), storagePrefix);
  const savedTransactions = await page.evaluate((key) => JSON.parse(localStorage.getItem(`${key}:tx`) || "[]"), storagePrefix);
  expect(savedData.categories).toEqual(["Importada QA"]);
  expect(savedTransactions).toHaveLength(1);
  expect(savedTransactions[0]).toMatchObject({ id: "backup-transaction-qa", amountCents: 1234 });
  await expect(page.getByText("Backup restaurado e sincronização iniciada.")).toBeVisible();
});
