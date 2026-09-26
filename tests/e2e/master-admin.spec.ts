import { test, expect } from "./fixtures";

const masterId = "00000000-0000-4000-8000-000000000001";
const pendingId = "00000000-0000-4000-8000-000000000002";
const emailPendingId = "00000000-0000-4000-8000-000000000003";
const trashedId = "00000000-0000-4000-8000-000000000004";

function encode(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

async function signInAsMaster(page: import("@playwright/test").Page, options: { manyRequests?: boolean; manyUsers?: boolean; inviteHistory?: boolean; failedAudit?: boolean; needsAttentionAudit?: boolean } = {}) {
  let pendingRequestArchived = false;
  let activeInviteRevoked = false;
  const now = Math.floor(Date.now() / 1000);
  const accessToken = encode({ alg: "none", typ: "JWT" }) + "." + encode({
    sub: masterId,
    aud: "authenticated",
    role: "authenticated",
    iat: now,
    exp: now + 3600,
  }) + "." + Buffer.from("e2e-signature").toString("base64url");
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
    body: JSON.stringify({ session: {
      access_token: accessToken,
      refresh_token: "e2e-refresh-token",
      token_type: "bearer",
      expires_in: 3600,
      expires_at: now + 3600,
      user,
    }, user }),
  }));
  await page.route("**/auth/v1/user**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(user) }));
  await page.route("**/rest/v1/profiles**", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ full_name: "Master E2E", account_status: "active", account_role: "master" }),
  }));

  await page.route("**/api/admin/users**", async (route) => {
    const method = route.request().method();
    if (method === "POST") {
      const body = route.request().postDataJSON() as { userId: string; action: string; reasonCode?: string };
      if (body.userId === pendingId && body.action === "archive_request") {
        pendingRequestArchived = true;
        route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
        return;
      }
      if (body.userId === pendingId && body.action === "reopen_request") {
        pendingRequestArchived = false;
        route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
        return;
      }
      if ((body.action === "approve" || body.action === "reject") && body.userId === pendingId) {
        route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
        return;
      }
      if ((body.action === "trash" || body.action === "restore" || body.action === "delete_permanently") && body.userId === trashedId) {
        route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
        return;
      }
      route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "Ação inválida para este teste." }) });
      return;
    }
    const status = new URL(route.request().url()).searchParams.get("status");
    const requestedPage = Number(new URL(route.request().url()).searchParams.get("page") || 1);
    const confirmedRequests = options.manyRequests
      ? Array.from({ length: 26 }, (_, index) => {
        const number = index + 1;
        return {
          id: number === 1 ? pendingId : `00000000-0000-4000-8000-${String(number + 100).padStart(12, "0")}`,
          email: `pedido${number}@valurise.invalid`,
          email_confirmed_at: new Date().toISOString(),
          last_sign_in_at: null,
          created_at: new Date(Date.now() - number * 60_000).toISOString(),
          full_name: `Pedido Confirmado ${number}`,
          username: `pedido.confirmado${number}`,
          role: "user",
          stored_status: "pending",
          request_status: "pending_review",
          requested_at: new Date().toISOString(),
          invite_id: null,
          invite_state: "none",
          status: "pending",
        };
      }) : [{
        id: pendingId,
        email: "pedido@valurise.invalid",
        email_confirmed_at: new Date().toISOString(),
        last_sign_in_at: null,
        created_at: new Date().toISOString(),
        full_name: "Pedido Confirmado",
        username: "pedido.confirmado",
        role: "user",
        stored_status: "pending",
        request_status: "pending_review",
        requested_at: new Date().toISOString(),
        invite_id: null,
        invite_state: "none",
        status: "pending",
      }];
    const awaitingEmail = {
      id: emailPendingId,
      email: "confirmar@valurise.invalid",
      email_confirmed_at: null,
      last_sign_in_at: null,
      created_at: new Date(Date.now() - 27 * 60_000).toISOString(),
      full_name: "Aguardando E-mail",
      username: "aguardando.email",
      role: "user",
      stored_status: "pending",
      request_status: "pending_email",
      requested_at: new Date().toISOString(),
      invite_id: null,
      invite_state: "none",
      status: "pending_email",
    };
    const visibleConfirmedRequests = pendingRequestArchived ? [] : confirmedRequests;
    const allRequests = [...visibleConfirmedRequests, awaitingEmail].sort((first, second) => second.created_at.localeCompare(first.created_at));
    const requestSearch = new URL(route.request().url()).searchParams.get("search")?.toLowerCase() || "";
    const filteredRequests = allRequests.filter((account) => !requestSearch || `${account.email} ${account.full_name} ${account.username}`.toLowerCase().includes(requestSearch));
    const requestPage = filteredRequests.slice((requestedPage - 1) * 25, requestedPage * 25);
    const trashedAccount = pendingRequestArchived ? {
      id: pendingId,
      email: "pedido@valurise.invalid",
      email_confirmed_at: new Date().toISOString(),
      last_sign_in_at: null,
      created_at: new Date().toISOString(),
      full_name: "Pedido Confirmado",
      username: "pedido.confirmado",
      role: "user",
      stored_status: "trashed",
      request_status: "pending_review",
      requested_at: new Date().toISOString(),
      invite_id: null,
      invite_state: "none",
      status: "trashed",
    } : {
      id: trashedId,
      email: "lixeira@valurise.invalid",
      email_confirmed_at: new Date().toISOString(),
      last_sign_in_at: null,
      created_at: new Date().toISOString(),
      full_name: "Conta de Teste na Lixeira",
      username: "conta.lixeira",
      role: "user",
      stored_status: "trashed",
      request_status: "rejected",
      requested_at: new Date().toISOString(),
      invite_id: null,
      invite_state: "none",
      status: "trashed",
    };
    const pending = status === "requests" ? requestPage : status === "pending" ? options.manyRequests
      ? visibleConfirmedRequests.slice((requestedPage - 1) * 25, requestedPage * 25)
      : visibleConfirmedRequests : status === "pending_email" ? [awaitingEmail] : status === "trashed" ? [trashedAccount] : [];
    const manyUsers = options.manyUsers ? Array.from({ length: 206 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index + 500).padStart(12, "0")}`,
      email: `usuario${index + 1}@valurise.invalid`,
      email_confirmed_at: new Date().toISOString(),
      last_sign_in_at: null,
      created_at: new Date(Date.now() - index * 60_000).toISOString(),
      full_name: `Usuário de teste ${index + 1}`,
      username: `usuario.teste${index + 1}`,
      role: "user",
      stored_status: "active",
      request_status: null,
      requested_at: new Date().toISOString(),
      invite_id: null,
      invite_state: "none",
      status: "active",
    })) : [];
    const userSearch = new URL(route.request().url()).searchParams.get("search")?.toLowerCase() || "";
    const filteredManyUsers = manyUsers.filter((account) => !userSearch || `${account.email} ${account.full_name} ${account.username}`.toLowerCase().includes(userSearch));
    const displayedManyUsers = filteredManyUsers.slice((requestedPage - 1) * 25, requestedPage * 25);
    const pageItems = options.manyUsers && status !== "requests" && status !== "pending" && status !== "pending_email" && status !== "trashed" ? displayedManyUsers : pending;
    const pendingTotal = status === "requests" ? filteredRequests.length : options.manyRequests && status === "pending" ? 26 : pending.length;
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items: pageItems, total: status === "trashed" ? 1 : options.manyUsers && pageItems === displayedManyUsers ? filteredManyUsers.length : pendingTotal, page: requestedPage, pageSize: 25, stats: { pending: pendingRequestArchived ? 0 : options.manyRequests ? 26 : 1, email_pending: 1, total: options.manyUsers ? 206 : options.manyRequests ? 27 : 2, active: options.manyUsers ? 206 : 1, disabled: 0, trashed: status === "trashed" ? 1 : 0, rejected: 0 } }),
    });
  });
  await page.route("**/api/admin/invites**", async (route) => {
    if (route.request().method() === "POST") {
      route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ invite: { id: "invite-new", token: "e2e-token", link: "http://127.0.0.1:3000/?invite=e2e-token" } }) });
      return;
    }
    if (route.request().method() === "DELETE") {
      activeInviteRevoked = true;
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
      return;
    }
    const inviteRows = options.inviteHistory ? [
      { id: "invite-active", token: "active-token", link: "http://127.0.0.1:3000/?invite=active-token", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(), usedAt: null, usedByName: null, revokedAt: activeInviteRevoked ? new Date().toISOString() : null, status: activeInviteRevoked ? "revoked" : "active" },
      { id: "invite-used", token: "used-token", link: "", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(), usedAt: new Date().toISOString(), usedByName: "Pessoa convidada", revokedAt: null, status: "used" },
    ] : [];
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: inviteRows, total: inviteRows.length, page: 1, pageSize: 25 }) });
  });
  await page.route("**/api/admin/audit**", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ items: [options.failedAudit || options.needsAttentionAudit
      ? { id: "audit-failed-e2e", action: "trashed", outcome: options.needsAttentionAudit ? "needs_attention" : "failed", reason_code: "user_requested", reason_note: null, detail_code: options.needsAttentionAudit ? "audit_reconciliation_required" : "auth_ban_failed", target_ref: trashedId, created_at: new Date().toISOString(), actor_name: "Master E2E", actor_email: "master@valurise.invalid", target_name: "Conta de Teste na Lixeira", target_email: "lixeira@valurise.invalid" }
      : { id: "audit-e2e", action: "approved", outcome: "completed", reason_code: null, reason_note: null, detail_code: null, target_ref: null, created_at: new Date().toISOString(), actor_name: "Master E2E", actor_email: "master@valurise.invalid", target_name: "Pedido Confirmado", target_email: "pedido@valurise.invalid" }], total: 1, page: 1, pageSize: 25 }),
  }));

  await page.goto("/");
  const necessary = page.getByRole("button", { name: "Apenas necessários" });
  await necessary.waitFor({ state: "visible", timeout: 5000 }).catch(() => undefined);
  if (await necessary.isVisible().catch(() => false)) await necessary.click();
  await expect(page.locator('div[aria-hidden="false"] .login-shell')).toBeVisible();
  await page.getByLabel("Usuário ou e-mail").fill("master@valurise.invalid");
  await page.getByLabel("Senha", { exact: true }).fill("senha-ficticia-de-teste");
  await page.getByRole("button", { name: "Entrar na conta" }).click();
  await expect(page.getByRole("heading", { name: "Central do Master" })).toBeVisible();
}

test("painel Master mostra pedidos confirmados, mantém os outros em espera e oferece seções funcionais no mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signInAsMaster(page);

  await expect(page.getByText("Pedido Confirmado")).toBeVisible();
  await expect(page.getByRole("button", { name: "Aprovar" })).toBeVisible();
  await expect(page.getByText("Aguardando E-mail")).toBeVisible();
  await expect(page.getByText("Aguardando confirmação do e-mail")).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await page.getByRole("button", { name: "Aprovar" }).click();
  const approvalDialog = page.getByRole("dialog", { name: "Aprovar acesso" });
  await expect(approvalDialog.getByText(/O e-mail foi confirmado/)).toBeVisible();
  const approveAction = approvalDialog.getByRole("button", { name: "Aprovar acesso" });
  await expect(approveAction).toBeDisabled();
  await approvalDialog.getByLabel("Motivo para auditoria (obrigatório)").selectOption("user_requested");
  await approveAction.click();
  await expect(page.getByText("Acesso aprovado.")).toBeVisible();

  await page.getByRole("button", { name: "Usuários" }).click();
  await expect(page.getByLabel("Buscar por nome, usuário ou e-mail")).toBeVisible();
  await page.getByLabel("Buscar por nome, usuário ou e-mail").fill("inexistente");
  await expect(page.getByText("Nenhuma conta encontrada")).toBeVisible();

  await page.getByRole("button", { name: "Convites" }).click();
  await page.getByRole("button", { name: "Gerar convite" }).click();
  await expect(page.getByLabel("Link criado")).toHaveValue("http://127.0.0.1:3000/?invite=e2e-token");

  await page.getByRole("button", { name: "Auditoria" }).click();
  await expect(page.getByRole("article").getByText("Acesso aprovado", { exact: true })).toBeVisible();
  await expect(page.locator("#master-audit-filter")).toBeVisible();
  await expect(page.getByLabel("Resultado")).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("arquiva um pedido sem recusá-lo e permite reabri-lo pela lixeira", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signInAsMaster(page);

  await page.getByRole("button", { name: "Arquivar solicitação" }).click();
  const archiveDialog = page.getByRole("dialog", { name: "Arquivar solicitação" });
  await expect(archiveDialog.getByText(/sem ser aprovado nem recusado/)).toBeVisible();
  await archiveDialog.getByLabel("Motivo para auditoria (obrigatório)").selectOption("user_requested");
  await archiveDialog.getByRole("button", { name: "Arquivar solicitação" }).click();
  await expect(page.getByText("Solicitação arquivada na lixeira sem ser recusada.")).toBeVisible();
  await expect(page.getByText("Nenhuma solicitação confirmada aguardando decisão.")).toBeVisible();

  await page.getByRole("button", { name: "Usuários" }).click();
  await page.locator("#master-account-status").selectOption("trashed");
  await expect(page.getByText("Pedido arquivado — ainda não aprovado nem recusado.")).toBeVisible();
  await page.locator('summary[aria-label="Ações de Pedido Confirmado"]').click();
  await page.getByRole("button", { name: "Reabrir solicitação" }).click();
  const reopenDialog = page.getByRole("dialog", { name: "Reabrir solicitação" });
  await expect(reopenDialog.getByText(/Reabrir não aprova nem libera a conta/)).toBeVisible();
  await reopenDialog.getByLabel("Motivo para auditoria (obrigatório)").selectOption("user_requested");
  await reopenDialog.getByRole("button", { name: "Reabrir solicitação" }).click();
  await expect(page.getByText("Solicitação reaberta e devolvida para análise.")).toBeVisible();

  await page.getByRole("navigation", { name: "Seções do painel Master" }).getByRole("button", { name: /Solicitações/ }).click();
  await expect(page.getByText("Pedido Confirmado")).toBeVisible();
  await expect(page.getByRole("button", { name: "Aprovar" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("notificação do Master abre a fila e leva ao pedido correto", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signInAsMaster(page);
  const notifications = page.getByRole("button", { name: /Solicitações aguardando análise: 1/ });
  await notifications.click();
  const dialog = page.getByRole("dialog", { name: "Notificações de acesso do Master" });
  const sheet = await dialog.boundingBox();
  expect(sheet).not.toBeNull();
  expect(sheet!.y + sheet!.height).toBeLessThanOrEqual(844);
  await dialog.getByRole("button", { name: "Fechar notificações" }).click();
  await expect(notifications).toHaveAttribute("aria-expanded", "false");
  await notifications.click();
  await expect(dialog.getByText("Pedido Confirmado")).toBeVisible();
  await dialog.getByRole("button", { name: /Pedido Confirmado/ }).click();
  await expect(page.getByLabel("Buscar solicitações por nome, usuário ou e-mail")).toHaveValue("pedido@valurise.invalid");
  await expect(page.locator(`#master-request-${pendingId}`)).toBeFocused();
});

test("fila de solicitações pagina sem saltar resultados", async ({ page }) => {
  await signInAsMaster(page, { manyRequests: true });
  await expect(page.getByText("Pedido Confirmado 1", { exact: true })).toBeVisible();
  await expect(page.getByText("Página 1 de 2 · 27 registros")).toBeVisible();
  await page.getByRole("button", { name: "Próxima página" }).click();
  await expect(page.getByText("Pedido Confirmado 26", { exact: true })).toBeVisible();
  await expect(page.getByText("Página 2 de 2 · 27 registros")).toBeVisible();
  await expect(page.getByRole("button", { name: "Próxima página" })).toBeDisabled();
});

test("lista mais de 200 contas com paginação, busca e menu de ações", async ({ page }) => {
  await signInAsMaster(page, { manyUsers: true });
  await page.getByRole("button", { name: "Usuários" }).click();

  await expect(page.getByText("Página 1 de 9 · 206 registros")).toBeVisible();
  await expect(page.getByText("Usuário de teste 1", { exact: true })).toBeVisible();
  for (let pageNumber = 2; pageNumber <= 9; pageNumber += 1) {
    await page.getByRole("button", { name: "Próxima página" }).click();
  }
  await expect(page.getByText("Página 9 de 9 · 206 registros")).toBeVisible();
  await expect(page.getByText("Usuário de teste 206", { exact: true })).toBeVisible();
  await page.getByLabel("Buscar por nome, usuário ou e-mail").fill("usuario206@");
  await expect(page.getByText("Página 1 de 1 · 1 registro")).toBeVisible();
  await page.locator('summary[aria-label="Ações de Usuário de teste 206"]').click();
  await expect(page.getByRole("button", { name: "Desativar conta" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("convites mostram validade e uso, e o Master consegue revogar um convite ativo", async ({ page }) => {
  await signInAsMaster(page, { inviteHistory: true });
  await page.getByRole("button", { name: "Convites" }).click();

  await expect(page.getByText("Convite ativo", { exact: true })).toBeVisible();
  await expect(page.getByText("Utilizado", { exact: true })).toBeVisible();
  await expect(page.getByText("Usado por Pessoa convidada")).toBeVisible();
  await page.getByRole("button", { name: "Cancelar", exact: true }).click();
  await expect(page.getByText("Convite cancelado.")).toBeVisible();
  await expect(page.getByText("Convite ativo", { exact: true })).toHaveCount(0);
});

test("filtra auditoria por ação, resultado e período", async ({ page }) => {
  await signInAsMaster(page);
  await page.getByRole("button", { name: "Auditoria" }).click();
  await page.locator("#master-audit-filter").selectOption("disabled");
  await page.locator("#master-audit-outcome").selectOption("failed");

  const filteredRequest = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return url.pathname === "/api/admin/audit"
      && url.searchParams.get("action") === "disabled"
      && url.searchParams.get("outcome") === "failed"
      && Boolean(url.searchParams.get("since"))
      && Boolean(url.searchParams.get("until"));
  });
  await page.locator("#master-audit-since").fill("2026-09-01");
  await page.locator("#master-audit-until").fill("2026-09-30");
  const request = await filteredRequest;
  const query = new URL(request.url()).searchParams;
  expect(query.get("action")).toBe("disabled");
  expect(query.get("outcome")).toBe("failed");
  expect(query.get("since")).toBeTruthy();
  expect(query.get("until")).toBeTruthy();

  await page.getByRole("button", { name: "Limpar filtros" }).click();
  await expect(page.locator("#master-audit-outcome")).toHaveValue("");
  await expect(page.locator("#master-audit-since")).toHaveValue("");
});

test("recusa exige motivo e exclusão definitiva exige reautenticação e confirmação digitada", async ({ page }) => {
  await signInAsMaster(page);
  await page.getByRole("button", { name: "Recusar", exact: true }).click();
  const rejectionDialog = page.getByRole("dialog", { name: "Recusar solicitação" });
  const rejectAction = rejectionDialog.getByRole("button", { name: "Recusar solicitação" });
  await expect(rejectAction).toBeDisabled();
  await rejectionDialog.getByLabel("Motivo para auditoria (obrigatório)").selectOption("policy_violation");
  await rejectAction.click();
  await expect(page.getByText("Solicitação recusada.")).toBeVisible();

  await page.getByRole("button", { name: "Usuários" }).click();
  await page.getByLabel("Filtrar contas").selectOption("trashed");
  await expect(page.getByText("Conta de Teste na Lixeira")).toBeVisible();
  await page.locator('summary[aria-label="Ações de Conta de Teste na Lixeira"]').click();
  await expect(page.getByRole("button", { name: "Restaurar conta" })).toHaveCount(0);
  await page.getByRole("button", { name: "Excluir definitivamente" }).click();
  const deleteDialog = page.getByRole("dialog", { name: "Excluir definitivamente?" });
  const confirmDelete = deleteDialog.getByRole("button", { name: "Excluir definitivamente" });
  await expect(confirmDelete).toBeDisabled();
  await deleteDialog.getByLabel("Motivo para auditoria (obrigatório)").selectOption("user_requested");
  await deleteDialog.getByLabel("Confirme sua senha Master").fill("senha-ficticia-de-teste");
  await deleteDialog.getByLabel("Digite EXCLUIR para confirmar").fill("EXCLUIR");
  await expect(confirmDelete).toBeEnabled();
  await confirmDelete.click();
  await expect(page.getByText("Conta excluída definitivamente.")).toBeVisible();
});

test("permite tentar novamente uma etapa de acesso que falhou", async ({ page }) => {
  await signInAsMaster(page, { failedAudit: true });
  await page.getByRole("button", { name: "Auditoria" }).click();
  const failedEvent = page.getByRole("article").filter({ hasText: "Conta de Teste na Lixeira" });
  await expect(failedEvent.getByText("Falhou — pode ser tentada novamente")).toBeVisible();
  await failedEvent.getByRole("button", { name: "Tentar novamente" }).click();
  const retryDialog = page.getByRole("dialog");
  await retryDialog.getByLabel("Motivo para auditoria (obrigatório)").selectOption("user_requested");
  await retryDialog.getByRole("button", { name: "Mover para a lixeira" }).click();
  await expect(page.getByText("Conta movida para a lixeira.")).toBeVisible();
});

test("auditoria em reconciliação expõe uma nova tentativa segura", async ({ page }) => {
  await signInAsMaster(page, { needsAttentionAudit: true });
  await page.getByRole("button", { name: "Auditoria" }).click();
  const attentionEvent = page.getByRole("article").filter({ hasText: "Conta de Teste na Lixeira" });
  await expect(attentionEvent.getByText("Precisa de atenção")).toBeVisible();
  await attentionEvent.getByRole("button", { name: "Tentar novamente" }).click();
  const retryDialog = page.getByRole("dialog");
  await retryDialog.getByLabel("Motivo para auditoria (obrigatório)").selectOption("user_requested");
  await retryDialog.getByRole("button", { name: "Mover para a lixeira" }).click();
  await expect(page.getByText("Conta movida para a lixeira.")).toBeVisible();
});

test("painel Master cabe nas larguras mobile e desktop", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signInAsMaster(page);
  for (const width of [375, 390, 430, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByRole("heading", { name: "Central do Master" })).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
});
