import { describe, expect, it } from "vitest";
import { classifyValTask, getValServiceStatus, hasKnownZeroProviderQuota, indexValModelQuotaUsage, isApprovedFreeModel, isFallbackEligible, isFreeModelCatalogFresh, isProviderQuotaCoolingDown, providerCircuitDecision, providerQuotaUtilizationPercent, runFreeModelCandidates, selectFreeModels, type ValReadinessCandidate } from "./policy";

const model = (overrides: Partial<ValReadinessCandidate> = {}): ValReadinessCandidate => ({
  provider: "groq", modelId: "openai/gpt-oss-20b", isFree: true, freeVerified: true,
  enabled: true, supportsChat: true, supportsTools: true, supportsStructuredOutput: false,
  supportsReasoning: false, contextWindow: 8192, health: "HEALTHY", circuitOpenUntil: null,
  priority: 1, latencyMs: 300, successRate: 0.99, quotaRemainingRatio: 1,
  providerEnabled: true, freeTierConfirmed: true, ...overrides,
});

describe("Val FreeModelPolicy", () => {
  it("só informa Val operacional se houver modelo gratuito com ferramentas pronto agora", () => {
    expect(getValServiceStatus(true, [model()])).toBe("operational");
    expect(getValServiceStatus(false, [model()])).toBe("unavailable");
    expect(getValServiceStatus(true, [])).toBe("unavailable");
    expect(getValServiceStatus(true, [model({ supportsTools: false })])).toBe("unavailable");
    expect(getValServiceStatus(true, [model({ isFree: false })])).toBe("unavailable");
  });

  it("não conta circuitos aguardando sonda como serviço disponível", () => {
    expect(getValServiceStatus(true, [model({ requiresProbe: true })])).toBe("unavailable");
    expect(getValServiceStatus(true, [model({ requiresProviderProbe: true })])).toBe("unavailable");
    expect(getValServiceStatus(true, [model({ health: "DEGRADED" })])).toBe("degraded");
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
      { period_kind: "day", provider_id: "groq", model_id: "vendor/model-a", requests: 1, attempts: 2, input_tokens: 100, output_tokens: 40 },
      { period_kind: "day", provider_id: "groq", model_id: "vendor/model-a", requests: 1, attempts: 1, input_tokens: 80, output_tokens: 30 },
      { period_kind: "month", provider_id: null, model_id: null, requests: 1, attempts: 1, input_tokens: 20, output_tokens: 10 },
    ]);
    expect(usage.get("day:groq/vendor/model-a")).toEqual({ requests: 3, tokens: 250 });
    expect([...usage.keys()]).toEqual(["day:groq/vendor/model-a"]);
  });

  it("abre circuito do provider, bloqueia tentativas concorrentes e permite uma sonda após o cooldown", () => {
    const now = Date.parse("2026-09-28T12:00:00.000Z");
    expect(providerCircuitDecision("CIRCUIT_OPEN", "2026-09-28T12:01:00.000Z", now)).toBe("blocked");
    expect(providerCircuitDecision("HALF_OPEN", "2026-09-28T12:00:30.000Z", now)).toBe("blocked");
    expect(providerCircuitDecision("CIRCUIT_OPEN", "2026-09-28T11:59:00.000Z", now)).toBe("probe");
    expect(providerCircuitDecision("DEGRADED", null, now)).toBe("ready");
  });

  it("escolhe o próximo modelo somente dentro da allowlist gratuita", () => {
    const first = model({ modelId: "groq/a", priority: 1 });
    const second = model({ provider: "openrouter", modelId: "qwen/b", priority: 2, freeTierConfirmed: false });
    const paid = model({ provider: "openrouter", modelId: "paid/c", isFree: false, priority: 0 });
    expect(selectFreeModels([paid, second, first]).map(({ modelId }) => modelId)).toEqual(["groq/a", "qwen/b"]);
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

  it("falha fechado quando a conta Groq não está explicitamente atestada como tier gratuito", () => {
    expect(selectFreeModels([model({ freeTierConfirmed: false })])).toEqual([]);
  });

  it("classifica tarefas localmente e não repete erros determinísticos", () => {
    expect(classifyValTask("Registre um gasto", true, true)).toBe("ACTION_PROPOSAL");
    expect(classifyValTask("Quanto gastei?", true, false)).toBe("TOOL_CALL");
    expect(isFallbackEligible("RATE_LIMITED")).toBe(true);
    expect(isFallbackEligible("INVALID_REQUEST")).toBe(false);
  });

  it("faz fallback no máximo três vezes e nunca chama um modelo pago, inclusive se todos os gratuitos falham", async () => {
    const calls: string[] = [];
    const freeA = model({ modelId: "free/a", priority: 1 });
    const freeB = model({ provider: "openrouter", modelId: "free/b", priority: 2, freeTierConfirmed: false });
    const paid = model({ provider: "openrouter", modelId: "paid/c", isFree: false, priority: 0 });
    await expect(runFreeModelCandidates([freeA, freeB, paid], {}, 3, async (candidate) => {
      calls.push(candidate.modelId);
      throw Object.assign(new Error("unavailable"), { category: "PROVIDER_UNAVAILABLE" });
    })).rejects.toMatchObject({ code: "ALL_FREE_MODELS_UNAVAILABLE" });
    expect(calls).toEqual(["free/a", "free/b"]);
  });

  it("não repete uma solicitação inválida em outros modelos", async () => {
    const calls: string[] = [];
    await expect(runFreeModelCandidates([model(), model({ provider: "openrouter", modelId: "free/2", freeTierConfirmed: false })], {}, 3, async (candidate) => {
      calls.push(candidate.modelId);
      throw Object.assign(new Error("bad request"), { category: "INVALID_REQUEST" });
    })).rejects.toThrow("bad request");
    expect(calls).toHaveLength(1);
  });
});
