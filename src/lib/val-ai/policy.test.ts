import { describe, expect, it } from "vitest";
import { classifyValTask, estimateValRequestCostUsd, getValServiceStatus, hasKnownZeroProviderQuota, indexValModelQuotaUsage, isApprovedFreeModel, isFallbackEligible, isFreeModelCatalogFresh, isProviderQuotaCoolingDown, isApprovedValModel, isValProviderAllowed, providerCircuitDecision, providerQuotaUtilizationPercent, runFreeModelCandidates, runValModelCandidates, selectFreeModels, selectValModels, type ValReadinessCandidate, type ValProvider } from "./policy";

const model = (overrides: Partial<ValReadinessCandidate> = {}): ValReadinessCandidate => ({
  provider: "deepseek", modelId: "deepseek-chat", isFree: true, freeVerified: true,
  enabled: true, supportsChat: true, supportsTools: true, supportsStructuredOutput: false,
  supportsReasoning: false, contextWindow: 8192, health: "HEALTHY", circuitOpenUntil: null,
  priority: 1, latencyMs: 300, successRate: 0.99, quotaRemainingRatio: 1,
  providerEnabled: true, ...overrides,
});

describe("Val model routing policy", () => {
  it("allows only DeepSeek as the central provider", () => {
    expect(isValProviderAllowed("deepseek")).toBe(true);
    expect(isValProviderAllowed("groq")).toBe(false);
    expect(isValProviderAllowed("openrouter")).toBe(false);
    expect(isValProviderAllowed("openai")).toBe(false);
  });

  it("só informa Val operacional se houver modelo habilitado com ferramentas pronto agora", () => {
    expect(getValServiceStatus(true, [model()])).toBe("operational");
    expect(getValServiceStatus(false, [model()])).toBe("unavailable");
    expect(getValServiceStatus(true, [])).toBe("unavailable");
    expect(getValServiceStatus(true, [model({ supportsTools: false })])).toBe("unavailable");
    expect(getValServiceStatus(true, [model({ provider: "deepseek", isFree: false, freeVerified: false })])).toBe("operational");
  });

  it("não conta circuitos aguardando sonda como serviço disponível", () => {
    expect(getValServiceStatus(true, [model({ requiresProbe: true })])).toBe("unavailable");
    expect(getValServiceStatus(true, [model({ requiresProviderProbe: true })])).toBe("unavailable");
    expect(getValServiceStatus(true, [model({ health: "DEGRADED" })])).toBe("degraded");
  });

  it("autoriza DeepSeek pago apenas quando provider e modelo estão explicitamente habilitados", () => {
    const deepseek = model({ provider: "deepseek", modelId: "deepseek-flash", isFree: false, freeVerified: false });
    expect(isApprovedValModel(deepseek, { tools: true })).toBe(true);
    expect(selectValModels([deepseek]).map(({ modelId }) => modelId)).toEqual(["deepseek-flash"]);
    expect(selectValModels([deepseek, model({ enabled: false, priority: 0 })])).toHaveLength(1);
    expect(selectValModels([deepseek, model({ providerEnabled: false, priority: 0 })])).toHaveLength(1);
  });

  it("estima custos com preços explicitamente configurados e falha fechado sem preços", () => {
    expect(estimateValRequestCostUsd({ inputTokens: 1_000_000, outputTokens: 500_000, inputCostPerMillion: 0.3, outputCostPerMillion: 1.2 })).toBeCloseTo(0.9);
    expect(estimateValRequestCostUsd({ inputTokens: 100, outputTokens: 10, inputCostPerMillion: null, outputCostPerMillion: 1.2 })).toBeNull();
  });

  it("bloqueia modelos pagos mesmo quando são saudáveis e têm prioridade maior", () => {
    const paid = model({ modelId: "vendor/paid", isFree: false });
    expect(isApprovedFreeModel(paid)).toBe(false);
    expect(selectFreeModels([paid])).toEqual([]);
  });

  it("não confia apenas no sufixo :free nem em nomes de modelo", () => {
    const unverified = model({ modelId: "vendor/model:free", freeVerified: false });
    expect(selectFreeModels([unverified])).toEqual([]);
  });

  it("exige catálogo gratuito atualizado e falha fechado para verificação antiga ou futura", () => {
    const now = Date.parse("2026-09-28T12:00:00.000Z");
    expect(isFreeModelCatalogFresh("2026-09-28T11:00:00.000Z", now)).toBe(true);
    expect(isFreeModelCatalogFresh("2026-09-26T11:00:00.000Z", now)).toBe(false);
    expect(isFreeModelCatalogFresh("2026-09-28T13:00:00.000Z", now)).toBe(false);
    expect(isFreeModelCatalogFresh(null, now)).toBe(false);
  });

  it("usa somente limites de uso informados oficialmente e mede a maior pressão entre requests/tokens", () => {
    expect(providerQuotaUtilizationPercent({ "x-ratelimit-limit-tokens": "1000", "x-ratelimit-remaining-tokens": "100", "x-ratelimit-limit-requests": "10", "x-ratelimit-remaining-requests": "3" })).toBe(90);
    expect(providerQuotaUtilizationPercent({ "x-ratelimit-limit": "100", "x-ratelimit-remaining": "0" })).toBe(100);
    expect(providerQuotaUtilizationPercent({ "x-ratelimit-limit-tokens": "unknown", "x-ratelimit-remaining-tokens": "3" })).toBeNull();
  });

  it("trata cota ausente como desconhecida, sem bloqueá-la como se fosse zero", () => {
    expect(hasKnownZeroProviderQuota({})).toBe(false);
    expect(hasKnownZeroProviderQuota({ "x-ratelimit-remaining-tokens": "" })).toBe(false);
    expect(hasKnownZeroProviderQuota({ "x-ratelimit-remaining-tokens": "0" })).toBe(true);
    expect(hasKnownZeroProviderQuota({ "x-ratelimit-remaining-requests": "0" })).toBe(true);
    expect(hasKnownZeroProviderQuota({ "x-ratelimit-remaining-tokens": "12", "x-ratelimit-remaining-requests": "0" })).toBe(true);
    expect(hasKnownZeroProviderQuota({ "x-ratelimit-remaining": "12" })).toBe(false);
  });

  it("respeita o tempo explícito de recuperação sem inventar pausa para metadados ausentes", () => {
    const now = Date.parse("2026-09-28T12:00:00.000Z");
    const observedAt = new Date(now).toISOString();
    expect(isProviderQuotaCoolingDown({}, observedAt, now)).toBe(false);
    expect(isProviderQuotaCoolingDown({ "retry-after": "9.3" }, observedAt, now)).toBe(true);
    expect(isProviderQuotaCoolingDown({ "retry-after": "9.3" }, observedAt, now + 10_000)).toBe(false);
    expect(isProviderQuotaCoolingDown({ "x-ratelimit-remaining-tokens": "0" }, observedAt, now)).toBe(true);
  });

  it("conta cada tentativa do provider, inclusive fallback, para as cotas por modelo", () => {
    const usage = indexValModelQuotaUsage([
      { period_kind: "day", provider_id: "deepseek", model_id: "deepseek-chat", requests: 1, attempts: 2, input_tokens: 100, output_tokens: 40 },
      { period_kind: "day", provider_id: "deepseek", model_id: "deepseek-chat", requests: 1, attempts: 1, input_tokens: 80, output_tokens: 30 },
      { period_kind: "month", provider_id: null, model_id: null, requests: 1, attempts: 1, input_tokens: 20, output_tokens: 10 },
    ]);
    expect(usage.get("day:deepseek/deepseek-chat")).toEqual({ requests: 3, tokens: 250 });
    expect([...usage.keys()]).toEqual(["day:deepseek/deepseek-chat"]);
  });

  it("abre circuito do provider, bloqueia tentativas concorrentes e permite uma sonda após o cooldown", () => {
    const now = Date.parse("2026-09-28T12:00:00.000Z");
    expect(providerCircuitDecision("CIRCUIT_OPEN", "2026-09-28T12:01:00.000Z", now)).toBe("blocked");
    expect(providerCircuitDecision("HALF_OPEN", "2026-09-28T12:00:30.000Z", now)).toBe("blocked");
    expect(providerCircuitDecision("CIRCUIT_OPEN", "2026-09-28T11:59:00.000Z", now)).toBe("probe");
    expect(providerCircuitDecision("DEGRADED", null, now)).toBe("ready");
  });

  it("rejeita providers legados mesmo quando aparecem como candidatos saudáveis", () => {
    const legacy = model({ provider: "openrouter" as unknown as ValProvider, modelId: "legacy/model" });
    expect(isApprovedValModel(legacy)).toBe(false);
    expect(selectValModels([legacy])).toEqual([]);
  });

  it("exclui candidatos que não suportam tools, quota, health ou circuit breaker", () => {
    const candidates = [
      model({ modelId: "no-tools", supportsTools: false }),
      model({ modelId: "no-quota", quotaRemainingRatio: 0 }),
      model({ modelId: "open-circuit", health: "CIRCUIT_OPEN", circuitOpenUntil: new Date(Date.now() + 60_000).toISOString() }),
      model({ modelId: "valid" }),
    ];
    expect(selectFreeModels(candidates, { tools: true }).map(({ modelId }) => modelId)).toEqual(["valid"]);
  });

  it("mantém o caminho de seleção gratuito fechado para modelos DeepSeek pagos", () => {
    expect(selectFreeModels([model({ isFree: false, freeVerified: false })])).toEqual([]);
  });

  it("classifica tarefas localmente e não repete erros determinísticos", () => {
    expect(classifyValTask("Registre um gasto", true, true)).toBe("ACTION_PROPOSAL");
    expect(classifyValTask("Quanto gastei?", true, false)).toBe("TOOL_CALL");
    expect(isFallbackEligible("RATE_LIMITED")).toBe(true);
    expect(isFallbackEligible("INVALID_REQUEST")).toBe(false);
  });

  it("faz fallback gratuito entre modelos DeepSeek e nunca chama um modelo pago", async () => {
    const calls: string[] = [];
    const freeA = model({ modelId: "deepseek/free-a", priority: 1 });
    const freeB = model({ modelId: "deepseek/free-b", priority: 2 });
    const paid = model({ modelId: "deepseek/paid-c", isFree: false, priority: 0 });
    await expect(runFreeModelCandidates([freeA, freeB, paid], {}, 3, async (candidate) => {
      calls.push(candidate.modelId);
      throw Object.assign(new Error("model unavailable"), { category: "MODEL_UNAVAILABLE" });
    })).rejects.toMatchObject({ code: "ALL_FREE_MODELS_UNAVAILABLE" });
    expect(calls).toEqual(["deepseek/free-a", "deepseek/free-b"]);
  });

  it("não repete uma solicitação inválida em outros modelos", async () => {
    const calls: string[] = [];
    await expect(runFreeModelCandidates([model(), model({ modelId: "deepseek/free-2" })], {}, 3, async (candidate) => {
      calls.push(candidate.modelId);
      throw Object.assign(new Error("bad request"), { category: "INVALID_REQUEST" });
    })).rejects.toThrow("bad request");
    expect(calls).toHaveLength(1);
  });

  it("só tenta fallback se o roteador entregar outro modelo explicitamente habilitado", async () => {
    const calls: string[] = [];
    const primary = model({ provider: "deepseek", modelId: "deepseek-flash", isFree: false, freeVerified: false, priority: 1 });
    const disabledBackup = model({ provider: "deepseek", modelId: "deepseek-backup", enabled: false, priority: 2 });
    await expect(runValModelCandidates([primary, disabledBackup], {}, 3, async (candidate) => {
      calls.push(candidate.modelId);
      throw Object.assign(new Error("model unavailable"), { category: "MODEL_UNAVAILABLE" });
    })).rejects.toMatchObject({ code: "ALL_ENABLED_MODELS_UNAVAILABLE" });
    expect(calls).toEqual(["deepseek-flash"]);
  });

  it("usa somente o próximo modelo DeepSeek habilitado quando o fallback é liberado", async () => {
    const calls: string[] = [];
    const primary = model({ provider: "deepseek", modelId: "deepseek-flash", isFree: false, freeVerified: false, priority: 1 });
    const backup = model({ provider: "deepseek", modelId: "deepseek-backup", isFree: false, freeVerified: false, priority: 2 });
    const result = await runValModelCandidates([primary, backup], {}, 2, async (candidate) => {
      calls.push(candidate.modelId);
      if (candidate.modelId === "deepseek-flash") throw Object.assign(new Error("model unavailable"), { category: "MODEL_UNAVAILABLE" });
      return "resposta simulada";
    });
    expect(result.candidate.modelId).toBe("deepseek-backup");
    expect(calls).toEqual(["deepseek-flash", "deepseek-backup"]);
  });

  it("never calls a legacy provider even if inserted directly into fallback candidates", async () => {
    const legacy = model({ provider: "groq" as unknown as ValProvider, modelId: "legacy/paid" });
    const calls: string[] = [];
    await expect(runValModelCandidates([legacy], {}, 3, async (candidate) => {
      calls.push(candidate.modelId);
      return "must not run";
    })).rejects.toMatchObject({ code: "ALL_ENABLED_MODELS_UNAVAILABLE" });
    expect(calls).toEqual([]);
  });
});
