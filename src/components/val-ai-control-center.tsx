"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GroupedIntegerInput } from "@/components/numeric-inputs";
import { Activity, Check, CircleAlert, KeyRound, RefreshCw, ShieldCheck, Users, Zap } from "lucide-react";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { providerQuotaUtilizationPercent } from "@/lib/val-ai/policy";
import { parseGroupedInteger } from "@/lib/numeric-input";

type Provider = { id: "deepseek"; enabled: boolean; health_status: string; failure_count: number; circuit_open_until: string | null; priority: number; last_health_check: string | null; last_latency_ms: number | null; last_error_category: string | null; quota_headers: Record<string, string>; updated_at: string };
type KeyInfo = { id: string; provider_id: "deepseek"; key_suffix: string; is_active: boolean; updated_at: string };
type Model = { id: string; provider_id: "deepseek"; model_id: string; display_name: string; is_free: boolean; free_verified: boolean; free_evidence: string | null; is_enabled: boolean; priority: number; supports_chat: boolean; supports_tools: boolean; supports_structured_output: boolean; supports_reasoning: boolean; supports_streaming: boolean; context_window: number | null; health_status: string; last_health_check: string | null; last_success_at: string | null; last_failure_at: string | null; last_latency_ms: number | null; last_error_category: string | null; failure_count: number; circuit_open_until: string | null; official_prompt_price: number | null; official_completion_price: number | null; input_cost_per_million: number | null; output_cost_per_million: number | null; pricing_source: string | null; price_verified_at: string | null; daily_request_limit: number | null; monthly_request_limit: number | null; daily_token_limit: number | null; monthly_token_limit: number | null; catalog_seen_at: string | null };
type ValAIData = {
  providers: Provider[]; keys: KeyInfo[]; models: Model[]; settings: Record<string, unknown>;
  overview: { status: string; requestsToday: number; requestsMonth: number; tokensToday: number; tokensMonth: number; estimatedCostTodayUsd: number; estimatedCostMonthUsd: number; successRate: number | null; failuresToday: number; fallbacksToday: number; activeProviders: number; readyModels: number; averageLatencyMs: number | null; uniqueUsersToday: number };
  usageByModel: Array<Record<string, unknown>>;
  recentErrors: Array<Record<string, unknown>>;
  users: Array<{ user: Record<string, unknown>; daily: Record<string, unknown>; monthly: Record<string, unknown>; override: Record<string, unknown> | null }>;
  audit: Array<Record<string, unknown>>;
};
type ProviderId = Provider["id"];
type Tab = "overview" | "providers" | "models" | "costs" | "quotas" | "users" | "logs";

const names: Record<ProviderId, string> = { deepseek: "DeepSeek" };
const tabs: Array<{ id: Tab; label: string; icon: typeof Activity }> = [
  { id: "providers", label: "Provedores", icon: KeyRound }, { id: "overview", label: "Visão geral", icon: Activity },
  { id: "models", label: "Modelos", icon: Zap }, { id: "costs", label: "Uso e custos", icon: Activity }, { id: "quotas", label: "Cotas e limites", icon: ShieldCheck },
  { id: "users", label: "Usuários", icon: Users }, { id: "logs", label: "Logs e auditoria", icon: CircleAlert },
];

const numberField = (value: unknown, fallback: number) => Number.isSafeInteger(Number(value)) ? Number(value) : fallback;
const decimalField = (value: unknown, fallback: number) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const dateTime = (value: unknown) => typeof value === "string" ? new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(new Date(value)) : "—";
const usd = (value: unknown) => value === null || value === undefined ? "—" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 4 }).format(Number(value));

function healthLabel(health: string | null | undefined, lastCheck?: string | null) {
  if (health === "DEGRADED" && !lastCheck) return "Aguardando validação";
  switch (health) {
    case "HEALTHY": return "Conexão validada";
    case "DEGRADED": return "Atenção · teste com falha";
    case "CIRCUIT_OPEN": return "Pausado temporariamente";
    case "HALF_OPEN": return "Em verificação";
    case "QUOTA_EXHAUSTED": return "Cota esgotada";
    case "UNAVAILABLE": return "Indisponível";
    case "DISABLED": return "Desativado";
    default: return "Não verificado";
  }
}

function errorCategoryLabel(category: string | null | undefined) {
  if (!category) return null;
  const labels: Record<string, string> = {
    INVALID_API_KEY: "chave recusada pelo provider",
    INSUFFICIENT_BALANCE: "saldo insuficiente na conta do provider",
    BALANCE_REQUIRED: "saldo insuficiente na conta do provider",
    RATE_LIMITED: "limite temporário de chamadas atingido",
    QUOTA_EXCEEDED: "cota do provider esgotada",
    BILLING_REQUIRED: "a conta do provider precisa de créditos/faturamento ativo",
    PERMISSION_DENIED: "a chave não tem permissão para este modelo",
    PROVIDER_UNAVAILABLE: "serviço do provider indisponível no momento",
    REGION_RESTRICTED: "modelo não disponível nesta região",
    MODEL_UNAVAILABLE: "modelo indisponível no provider",
    INVALID_MODEL: "identificador do modelo não reconhecido",
    TOOL_CALL_UNSUPPORTED: "o modelo não confirmou a ferramenta exigida pela Val",
    TIMEOUT: "o provider demorou além do limite de conexão",
    NETWORK_ERROR: "falha de rede ao conectar ao provider",
    GLOBAL_COST_LIMIT: "limite global de custo bloqueou a chamada",
    MODEL_PRICING_REQUIRED: "custos do modelo não foram configurados",
    VAL_ROUTER_DISABLED: "Val ou roteador desativado em Cotas e limites",
    PROVIDER_DISABLED: "provider desativado no roteamento",
    MODEL_NOT_ENABLED: "modelo de chat ainda não habilitado",
    PROVIDER_KEY_MISSING: "nenhuma chave ativa encontrada",
    VAL_MODEL_POLICY_BLOCKED: "o modelo não passou pelas regras de capacidade/saúde",
  };
  return labels[category] || category.toLowerCase().replaceAll("_", " ");
}

function connectionSuccessMessage(modelId: string, result: unknown) {
  if (!result || typeof result !== "object") return `Conexão validada · ${modelId}.`;
  const details = result as Record<string, unknown>;
  const latency = Number.isFinite(Number(details.latencyMs)) ? ` · ${Number(details.latencyMs)} ms` : "";
  const tools = details.toolCallValidated === true ? " · ferramenta validada" : "";
  return `Conexão validada · ${modelId}${latency}${tools}.`;
}

export function ValAIControlCenter({ toast }: { toast: (message: string) => void }) {
  const [tab, setTab] = useState<Tab>("providers");
  const [data, setData] = useState<ValAIData | null>(null);
  const [settings, setSettings] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadDiagnostic, setLoadDiagnostic] = useState<string | null>(null);

  const tokenHeaders = useCallback(async () => {
    const { data: sessionData } = await getSupabaseBrowserClient()?.auth.getSession() || {};
    const token = sessionData?.session?.access_token;
    return token ? { Authorization: `Bearer ${token}` } : null;
  }, []);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setLoadDiagnostic(null);
    try {
      const headers = await tokenHeaders();
      if (!headers) throw new Error("Sua sessão expirou. Entre novamente no Super Admin.");
      const response = await fetch("/api/admin/val-ai", { headers, cache: "no-store" });
      const result = await response.json();
      if (!response.ok) {
        setLoadDiagnostic(typeof result.technical === "string" ? result.technical : null);
        throw new Error(result.error || "Não foi possível carregar a Central da Val.");
      }
      setData(result as ValAIData);
      setSettings(result.settings || {});
      setLoadError(null);
      setLoadDiagnostic(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Não foi possível atualizar a Central da Val.";
      setLoadError(message);
    } finally { setLoading(false); setRefreshing(false); }
  }, [tokenHeaders]);

  useEffect(() => { void refresh(); }, [refresh]);

  const post = useCallback(async (payload: Record<string, unknown>, successMessage?: string) => {
    const headers = await tokenHeaders();
    if (!headers) throw new Error("Sua sessão expirou. Entre novamente no Super Admin.");
    const response = await fetch("/api/admin/val-ai", { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const result = await response.json();
    if (!response.ok) {
      const message = typeof result.error === "string" ? result.error : "A operação não foi concluída.";
      if (payload.action === "test_model") {
        await refresh();
        const categoryCode = typeof result.category === "string" ? result.category : typeof result.code === "string" ? result.code : null;
        const diagnostics = [
          categoryCode && /^[A-Z0-9_.-]{1,80}$/.test(categoryCode) ? `categoria: ${errorCategoryLabel(categoryCode)}` : null,
          Number.isInteger(result.httpStatus) ? `HTTP ${result.httpStatus}` : null,
          typeof result.providerCode === "string" && /^[A-Z0-9_.-]{1,80}$/.test(result.providerCode) ? `código: ${result.providerCode}` : null,
        ].filter(Boolean);
        throw new Error(diagnostics.length ? `${message} (${diagnostics.join(" · ")})` : message);
      }
      throw new Error(message);
    }
    if (successMessage) toast(successMessage);
    await refresh();
    return result;
  }, [tokenHeaders, toast, refresh]);

  const run = (operation: () => Promise<unknown>) => void operation().catch((error) => toast(error instanceof Error ? error.message : "A operação não foi concluída."));
  const providers = useMemo(() => new Map((data?.providers || []).map((provider) => [provider.id, provider])), [data]);

  if (loading) return <div role="status" className="panel mt-5 rounded-2xl p-6 text-sm">Carregando a Central da Val…</div>;
  if (!data) return <div role="alert" className="panel mt-5 rounded-2xl p-6"><p className="text-sm">{loadError || "A Central da Val ainda não conseguiu carregar os dados."}</p>{loadDiagnostic && <details className="muted mt-3 text-xs"><summary className="cursor-pointer">Diagnóstico técnico</summary><p className="mt-2 break-all">{loadDiagnostic}</p></details>}<button type="button" disabled={refreshing} onClick={() => void refresh()} className="mt-3 min-h-10 rounded-xl bg-[var(--panel2)] px-3 text-xs disabled:opacity-50">{refreshing ? "Verificando…" : "Tentar novamente"}</button></div>;

  const overview = data.overview;
  const awaitingFirstTest = overview.status === "degraded"
    && data.providers.some((provider) => provider.enabled && provider.health_status === "DEGRADED" && !provider.last_health_check)
    && data.models.some((model) => model.is_enabled && model.supports_chat && model.health_status === "DEGRADED" && !model.last_health_check);
  const statusLabel = overview.status === "operational" ? "Operacional" : awaitingFirstTest ? "Aguardando validação" : overview.status === "degraded" ? "Degradado" : "Indisponível";
  const setting = (key: string, fallback: unknown) => settings[key] ?? fallback;

  return <section className="mt-5 space-y-4">
    <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div><p className="muted text-xs font-semibold uppercase tracking-[0.14em]">Super Admin</p><h1 className="mt-1 text-2xl font-semibold tracking-tight">Central da Val</h1><p className="muted mt-1 max-w-2xl text-sm">DeepSeek principal, custos estimados, limites, saúde e auditoria da assistente financeira.</p></div>
      <button type="button" disabled={refreshing} onClick={() => void refresh()} className="inline-flex min-h-10 items-center justify-center gap-2 self-start rounded-xl bg-[var(--panel2)] px-3 text-xs disabled:opacity-50"><RefreshCw size={14} className={refreshing ? "animate-spin" : ""}/>Atualizar</button>
    </header>

    <nav aria-label="Seções da Central da Val" className="grid grid-cols-2 gap-2 rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-2 sm:grid-cols-3 xl:grid-cols-7">
      {tabs.map(({ id, label, icon: Icon }) => <button type="button" key={id} aria-current={tab === id ? "page" : undefined} onClick={() => setTab(id)} className={`inline-flex min-h-10 items-center justify-center gap-2 rounded-xl px-2 text-xs font-medium ${tab === id ? "bg-[var(--accent)] text-[var(--accentfg)]" : "bg-[var(--panel2)] text-[var(--muted)]"}`}><Icon size={14}/>{label}</button>)}
    </nav>

    {tab === "overview" && <div className="space-y-4">
      <section className="panel rounded-2xl p-4 sm:p-5"><div className="flex flex-wrap items-center justify-between gap-3"><div><p className="muted text-xs">Status geral · DeepSeek</p><h2 className="mt-1 text-xl font-semibold">{statusLabel}</h2></div><span className={`rounded-full px-3 py-1.5 text-xs font-semibold ${overview.status === "operational" ? "bg-[var(--accent)]/15 text-[var(--accent)]" : "bg-[var(--panel2)] text-[var(--danger)]"}`}>{overview.readyModels} modelo(s) habilitado(s) e pronto(s)</span></div><p className="muted mt-3 text-xs leading-5">{overview.status === "operational" ? "Há modelo habilitado, com saúde e capacidade compatíveis para a Val." : awaitingFirstTest ? "O provedor e o modelo estão habilitados, mas a primeira chamada ainda não foi validada. Vá a Provedores e selecione “Validar conexão agora”." : overview.status === "degraded" ? "O último teste registrou uma falha. Confira o motivo em Provedores e execute uma nova validação." : "A DeepSeek ainda não está pronta. Verifique chave, modelo, saúde, limite mensal e controles de ativação."}</p></section>
      <div className="grid grid-cols-2 gap-2 xl:grid-cols-4">{[
        ["Consultas hoje", overview.requestsToday], ["Consultas no mês", overview.requestsMonth], ["Tokens hoje · medidos", overview.tokensToday], ["Tokens no mês · medidos", overview.tokensMonth],
        ["Custo estimado hoje", usd(overview.estimatedCostTodayUsd)], ["Custo estimado no mês", usd(overview.estimatedCostMonthUsd)], ["Usuários hoje", overview.uniqueUsersToday], ["Taxa de sucesso", overview.successRate === null ? "—" : `${overview.successRate}%`], ["Fallbacks hoje", overview.fallbacksToday], ["Latência média", overview.averageLatencyMs === null ? "—" : `${overview.averageLatencyMs} ms`],
      ].map(([label, value]) => <article key={String(label)} className="panel rounded-xl p-3 sm:p-4"><p className="muted text-[11px]">{label}</p><p className="mt-1 text-lg font-semibold tabular-nums">{typeof value === "number" ? value.toLocaleString("pt-BR") : value}</p></article>)}</div>
      <div className="grid gap-3 lg:grid-cols-1">{(["deepseek"] as ProviderId[]).map((id) => {
        const provider = providers.get(id); const key = data.keys.find((item) => item.provider_id === id);
        const headers = provider?.quota_headers || {};
        return <article key={id} className="panel min-w-0 rounded-2xl p-4"><div className="flex items-center justify-between gap-2"><h3 className="font-semibold">{names[id]}</h3><span className="muted text-xs">{provider?.enabled ? healthLabel(provider.health_status, provider.last_health_check) : "Desativado"}</span></div><p className="muted mt-1 text-xs">{key ? `Chave protegida · •••• ${key.key_suffix}` : "Nenhuma chave cadastrada"}</p><p className="muted mt-2 text-xs">Uso medido hoje: {overview.requestsToday.toLocaleString("pt-BR")} solicitações · {overview.tokensToday.toLocaleString("pt-BR")} tokens.</p><p className="muted mt-1 break-all text-[11px]">Metadados oficiais de cota: {Object.keys(headers).length ? Object.entries(headers).map(([name, value]) => `${name}: ${value}`).join(" · ") : "não informados pelo provider"}</p></article>;
      })}</div>
    </div>}

    {tab === "providers" && <div className="grid gap-3 xl:grid-cols-1">{(["deepseek"] as ProviderId[]).map((id) => <ProviderCard key={id} id={id} provider={providers.get(id)} keyInfo={data.keys.find((item) => item.provider_id === id)} models={data.models.filter((model) => model.provider_id === id)} thresholds={{ soft: numberField(settings.soft_quota_percent, 80), deprioritize: numberField(settings.deprioritize_quota_percent, 90), hard: numberField(settings.hard_quota_percent, 98) }} runtimeReady={settings.val_enabled === true && settings.val_router_enabled === true && settings.val_deepseek_enabled === true} onPost={post} run={run} toast={toast}/> )}</div>}

    {tab === "models" && <div className="space-y-3">
      {data.usageByModel.length > 0 && <section className="panel rounded-2xl p-4"><h2 className="text-sm font-semibold">Uso medido por modelo</h2><p className="muted mt-1 text-[11px]">Métricas calculadas pelo Valurise; os limites dos providers, quando existentes, aparecem separadamente.</p><div className="mt-3 space-y-2">{data.usageByModel.map((row, index) => <article key={`${String(row.period)}:${String(row.provider)}:${String(row.model)}:${index}`} className="flex flex-wrap justify-between gap-2 rounded-xl bg-[var(--panel2)] p-3"><span className="min-w-0 break-all text-xs">{String(row.provider)} / {String(row.model)} · {row.period === "day" ? "hoje" : "mês"}</span><span className="text-right text-[11px]">{Number(row.attempts ?? row.requests ?? 0).toLocaleString("pt-BR")} chamadas ao modelo · {Number(row.tokens || 0).toLocaleString("pt-BR")} tokens medidos</span></article>)}</div></section>}
      {data.models.length === 0 && <p className="panel muted rounded-2xl p-5 text-sm">Nenhum catálogo carregado ainda. Cadastre a chave e atualize o catálogo de cada provedor.</p>}
      {data.models.map((model) => <ModelCard key={model.id} model={model} provider={providers.get(model.provider_id)} usage={data.usageByModel.filter((row) => row.provider === model.provider_id && row.model === model.model_id)} onPost={post} run={run} toast={toast}/>)}</div>}

    {tab === "costs" && <div className="space-y-4">
      <section className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        {[["Custo estimado hoje", usd(overview.estimatedCostTodayUsd)], ["Custo estimado no mês", usd(overview.estimatedCostMonthUsd)], ["Limite mensal", usd(setting("monthly_cost_hard_limit_usd", 10))], ["Saldo oficial", "Não disponível via API"]].map(([label, value]) => <article key={label} className="panel rounded-xl p-3 sm:p-4"><p className="muted text-[11px]">{label}</p><p className="mt-1 text-base font-semibold tabular-nums">{value}</p></article>)}
      </section>
      <section className="panel rounded-2xl p-4"><h2 className="text-sm font-semibold">Consumo estimado por provider e modelo</h2><p className="muted mt-1 text-[11px]">Estimativa interna baseada nos tokens medidos e nos preços configurados por milhão. Não representa cobrança oficial.</p><div className="mt-3 space-y-2">{data.usageByModel.map((row, index) => <article key={`${String(row.period)}:${String(row.provider)}:${String(row.model)}:${index}`} className="flex flex-wrap justify-between gap-2 rounded-xl bg-[var(--panel2)] p-3"><span className="min-w-0 break-all text-xs">{String(row.provider)} / {String(row.model)} · {row.period === "day" ? "hoje" : "mês"}</span><span className="text-right text-[11px]">{usd(row.estimatedCostUsd)} estimados · {Number(row.tokens || 0).toLocaleString("pt-BR")} tokens</span></article>)}</div>{data.usageByModel.length === 0 && <p className="muted mt-3 text-xs">Ainda não há consumo registrado neste período.</p>}</section>
      <section className="panel rounded-2xl p-4"><h2 className="text-sm font-semibold">Alertas de consumo</h2><p className="muted mt-1 text-xs">{overview.estimatedCostMonthUsd >= Number(setting("monthly_cost_hard_limit_usd", 10)) ? "Limite mensal atingido: novas chamadas ficam bloqueadas." : overview.estimatedCostMonthUsd >= Number(setting("monthly_cost_soft_limit_usd", 8)) ? "Limite de atenção atingido; a Val continua ativa até o limite máximo." : "Consumo abaixo do limite de atenção."}</p><p className="muted mt-2 text-[11px]">Valor de referência configurado manualmente: {setting("reference_balance_usd", null) === null ? "não informado" : usd(setting("reference_balance_usd", null))}. Isso não é um saldo consultado na DeepSeek.</p></section>
    </div>}

    {tab === "quotas" && <section className="panel rounded-2xl p-4 sm:p-5"><h2 className="text-lg font-semibold">Cotas, gastos e roteamento</h2><p className="muted mt-1 text-xs leading-5">O padrão é 10 respostas válidas por usuário ao dia. Erros do provider não consomem consulta. DeepSeek é o único provider roteado por padrão; o fallback permanece desligado. O consentimento de cada usuário continua obrigatório para contexto financeiro.</p><p className="muted mt-2 text-xs leading-5">Custo é sempre uma estimativa interna. O saldo oficial só aparece se a API do provider o informar; o campo de referência manual não é saldo real.</p><div className="mt-4 grid gap-4 sm:grid-cols-2">
      <NumberInput label="Consultas por dia" value={setting("daily_requests", 10)} onChange={(value) => setSettings((state) => ({ ...state, daily_requests: value }))}/>
      <NumberInput label="Consultas por mês" value={setting("monthly_requests", 200)} onChange={(value) => setSettings((state) => ({ ...state, monthly_requests: value }))}/>
      <NumberInput label="Tokens por dia" value={setting("daily_tokens", 50000)} onChange={(value) => setSettings((state) => ({ ...state, daily_tokens: value }))}/>
      <NumberInput label="Tokens por mês" value={setting("monthly_tokens", 1000000)} onChange={(value) => setSettings((state) => ({ ...state, monthly_tokens: value }))}/>
      <NumberInput label="Contexto máximo (tokens)" value={setting("max_context_tokens", 12000)} onChange={(value) => setSettings((state) => ({ ...state, max_context_tokens: value }))}/>
      <NumberInput label="Saída máxima (tokens)" value={setting("max_output_tokens", 700)} onChange={(value) => setSettings((state) => ({ ...state, max_output_tokens: value }))}/>
      <NumberInput label="Máximo de tentativas totais · fallback" value={setting("max_attempts", 1)} min={1} max={3} onChange={(value) => setSettings((state) => ({ ...state, max_attempts: Math.min(3, Math.max(1, value ?? 1)) }))}/>
      <NumberInput label="Falhas para abrir circuito" value={setting("circuit_failure_threshold", 3)} min={1} max={20} onChange={(value) => setSettings((state) => ({ ...state, circuit_failure_threshold: value }))}/>
      <NumberInput label="Pausa do circuito (segundos)" value={setting("circuit_cooldown_seconds", 120)} min={10} max={86400} onChange={(value) => setSettings((state) => ({ ...state, circuit_cooldown_seconds: value }))}/>
      <NumberInput label="Atenção de cota oficial (%)" value={setting("soft_quota_percent", 80)} min={1} max={99} onChange={(value) => setSettings((state) => ({ ...state, soft_quota_percent: value }))}/>
      <NumberInput label="Reduzir prioridade em (%)" value={setting("deprioritize_quota_percent", 90)} min={2} max={99} onChange={(value) => setSettings((state) => ({ ...state, deprioritize_quota_percent: value }))}/>
      <NumberInput label="Bloquear em (%)" value={setting("hard_quota_percent", 98)} min={50} max={100} onChange={(value) => setSettings((state) => ({ ...state, hard_quota_percent: value }))}/>
      <DecimalInput label="Limite de atenção mensal (USD)" value={setting("monthly_cost_soft_limit_usd", 8)} onChange={(value) => setSettings((state) => ({ ...state, monthly_cost_soft_limit_usd: value }))}/>
      <DecimalInput label="Limite máximo mensal (USD)" value={setting("monthly_cost_hard_limit_usd", 10)} onChange={(value) => setSettings((state) => ({ ...state, monthly_cost_hard_limit_usd: value }))}/>
      <DecimalInput label="Saldo de referência manual (USD)" nullable value={setting("reference_balance_usd", null)} onChange={(value) => setSettings((state) => ({ ...state, reference_balance_usd: value }))}/>
    </div>
    <div className="mt-4 grid gap-2 sm:grid-cols-2">{[
      ["val_enabled", "Habilitar Val"], ["val_router_enabled", "Habilitar roteador"], ["val_deepseek_enabled", "Permitir DeepSeek no roteamento"], ["val_fallback_enabled", "Fallback entre modelos DeepSeek"], ["val_actions_enabled", "Permitir propostas de lançamentos"], ["val_insights_enabled", "Permitir análise financeira com consentimento"],
    ].map(([key, label]) => <label key={key} className="flex min-h-11 items-center gap-2 rounded-xl bg-[var(--panel2)] px-3 text-xs"><input type="checkbox" checked={Boolean(setting(key, key === "val_actions_enabled" || key === "val_insights_enabled"))} onChange={(event) => setSettings((state) => ({ ...state, [key]: event.target.checked }))} className="h-4 w-4 accent-[var(--accent)]"/>{label}</label>)}</div>
    <p className="muted mt-3 text-xs">As chamadas só seguem se o custo do modelo estiver cadastrado. O roteador reserva a estimativa antes de chamar o provider e bloqueia novas chamadas no hard limit.</p>
    <button type="button" onClick={() => run(() => post({ action: "save_limits", dailyRequests: numberField(settings.daily_requests, 10), monthlyRequests: numberField(settings.monthly_requests, 200), dailyTokens: numberField(settings.daily_tokens, 50000), monthlyTokens: numberField(settings.monthly_tokens, 1000000), maxContextTokens: numberField(settings.max_context_tokens, 12000), maxOutputTokens: numberField(settings.max_output_tokens, 700), maxAttempts: numberField(settings.max_attempts, 1), circuitFailureThreshold: numberField(settings.circuit_failure_threshold, 3), circuitCooldownSeconds: numberField(settings.circuit_cooldown_seconds, 120), softQuotaPercent: numberField(settings.soft_quota_percent, 80), deprioritizeQuotaPercent: numberField(settings.deprioritize_quota_percent, 90), hardQuotaPercent: numberField(settings.hard_quota_percent, 98), monthlyCostSoftLimitUsd: decimalField(settings.monthly_cost_soft_limit_usd, 8), monthlyCostHardLimitUsd: decimalField(settings.monthly_cost_hard_limit_usd, 10), referenceBalanceUsd: settings.reference_balance_usd == null || settings.reference_balance_usd === "" ? null : decimalField(settings.reference_balance_usd, 0), valEnabled: Boolean(setting("val_enabled", false)), routerEnabled: Boolean(setting("val_router_enabled", false)), deepseekEnabled: Boolean(setting("val_deepseek_enabled", true)), fallbackEnabled: Boolean(setting("val_fallback_enabled", false)), actionsEnabled: Boolean(setting("val_actions_enabled", true)), insightsEnabled: Boolean(setting("val_insights_enabled", true)) }, "Limites da Val atualizados."))} className="primary mt-4 min-h-11 rounded-xl px-4 text-sm font-semibold">Salvar limites e controles</button>
    </section>}

    {tab === "users" && <div className="space-y-3">{data.users.map((item) => <UserQuotaCard key={String(item.user.id)} row={item} onPost={post} run={run}/>)}</div>}

    {tab === "logs" && <div className="grid gap-4 xl:grid-cols-2"><section className="space-y-2"><h2 className="text-sm font-semibold">Erros recentes · dados técnicos seguros</h2>{data.recentErrors.map((item, index) => <article key={String(item.id || index)} className="panel overflow-hidden rounded-xl p-3"><div className="flex flex-wrap justify-between gap-2"><b className="text-xs">{String(item.error_category || "Falha")}</b><span className="muted text-[11px]">{dateTime(item.created_at)}</span></div><p className="muted mt-1 break-all text-[11px]">Req {String(item.request_id)} · {String(item.provider_id || "sem candidato")} / {String(item.model_id || "—")} · tentativa {String(item.attempt_index)}</p><p className="muted mt-1 break-all text-[11px]">Usuário {String(item.user_id)} · {String(item.task_type)} · HTTP {String(item.http_status || "—")} · {String(item.latency_ms)} ms</p></article>)}{!data.recentErrors.length && <p className="panel muted rounded-xl p-4 text-xs">Nenhum erro recente.</p>}</section><section className="space-y-2"><h2 className="text-sm font-semibold">Auditoria do Super Admin</h2>{data.audit.map((item) => <article key={String(item.id)} className="panel rounded-xl p-3"><div className="flex flex-wrap justify-between gap-2"><b className="text-xs">{String(item.action)}</b><span className="muted text-[11px]">{dateTime(item.created_at)}</span></div><p className="muted mt-1 text-[11px]">{String(item.outcome)} · {String(item.provider_id || "geral")} {item.model_id ? `/ ${String(item.model_id)}` : ""} {item.target_user_id ? `· usuário ${String(item.target_user_id)}` : ""}</p><p className="muted mt-1 break-words text-[11px]">{JSON.stringify(item.metadata || {})}</p></article>)}{!data.audit.length && <p className="panel muted rounded-xl p-4 text-xs">Nenhuma ação administrativa registrada ainda.</p>}</section></div>}
  </section>;
}

function ProviderCard({ id, provider, keyInfo, models, thresholds, runtimeReady, onPost, run, toast }: { id: ProviderId; provider?: Provider; keyInfo?: KeyInfo; models: Model[]; thresholds: { soft: number; deprioritize: number; hard: number }; runtimeReady: boolean; onPost: (payload: Record<string, unknown>, message?: string) => Promise<unknown>; run: (operation: () => Promise<unknown>) => void; toast: (message: string) => void }) {
  const [apiKey, setApiKey] = useState("");
  const [enabled, setEnabled] = useState(provider?.enabled || false);
  const [testing, setTesting] = useState(false);
  const testInFlight = useRef(false);
  useEffect(() => { setEnabled(provider?.enabled || false); }, [provider?.enabled]);
  const saveKey = () => run(async () => { if (apiKey.trim().length < 16) throw new Error("A chave está incompleta."); await onPost({ action: "save_key", provider: id, apiKey: apiKey.trim() }, "Chave guardada de forma criptografada."); setApiKey(""); });
  const setProvider = () => run(() => onPost({ action: "set_provider", provider: id, enabled }, enabled ? "Estado do provedor atualizado." : "Provedor desativado."));
  const removeKey = () => run(() => onPost({ action: "remove_key", provider: id }, "Chave removida e modelos desativados."));
  const testModel = models.find((model) => model.is_enabled && model.supports_chat);
  const quotaUsage = providerQuotaUtilizationPercent(provider?.quota_headers || {});
  const quotaStatus = quotaUsage === null ? "sem cota oficial reportada" : quotaUsage >= thresholds.hard ? "bloqueio preventivo" : quotaUsage >= thresholds.deprioritize ? "prioridade reduzida" : quotaUsage >= thresholds.soft ? "atenção" : "dentro do limite";
  const canTest = Boolean(keyInfo && testModel && provider?.enabled && runtimeReady && testModel.input_cost_per_million !== null && testModel.input_cost_per_million !== undefined && testModel.output_cost_per_million !== null && testModel.output_cost_per_million !== undefined);
  const hasCheckedConnection = Boolean(testModel?.last_health_check);
  const waitingForValidation = Boolean(provider?.enabled && keyInfo && testModel && !hasCheckedConnection);
  const testConnection = () => {
    if (!testModel || !canTest || testInFlight.current) return;
    testInFlight.current = true;
    setTesting(true);
    run(async () => {
      try {
        const result = await onPost({ action: "test_model", provider: id, modelId: testModel.model_id });
        toast(connectionSuccessMessage(testModel.model_id, result));
      } finally {
        testInFlight.current = false;
        setTesting(false);
      }
    });
  };
  const nextStep = !keyInfo
    ? "Cadastre a chave protegida para começar."
    : !provider?.enabled
      ? "Marque “Permitir este provider no roteamento” e salve a ativação."
      : !runtimeReady
        ? "Ative a Val, o roteador e a DeepSeek em “Cotas e limites”."
        : !testModel
          ? models.some((model) => model.supports_chat)
            ? "Habilite um modelo de chat e salve os custos na seção Modelos."
            : "Atualize o catálogo para localizar modelos de chat disponíveis."
          : testModel.input_cost_per_million == null || testModel.output_cost_per_million == null
            ? "Informe os custos de entrada e saída do modelo em Modelos para liberar a validação."
            : waitingForValidation
              ? "A chave foi salva, mas ainda não houve uma chamada de teste. “Degradada” é apenas o estado provisório até essa validação."
              : provider?.health_status === "DEGRADED" || testModel.health_status === "DEGRADED"
                ? `O último teste registrou: ${errorCategoryLabel(provider?.last_error_category) || errorCategoryLabel(testModel.last_error_category) || "falha sem categoria detalhada"}. Valide novamente após corrigir.`
                : "Conexão validada. Se a Val continuar indisponível, confira os limites e logs de uso.";
  const statusLabel = !provider?.enabled ? "Desativado" : waitingForValidation ? "Aguardando validação" : healthLabel(provider.health_status, provider.last_health_check);
  return <article className="panel min-w-0 rounded-2xl p-4 sm:p-5">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-lg font-semibold">{names[id]}{id === "deepseek" ? " · principal" : ""}</h2><p className="muted mt-1 text-xs">{statusLabel}{provider?.last_latency_ms !== null && provider?.last_latency_ms !== undefined ? ` · ${provider.last_latency_ms} ms` : ""}</p>{provider?.health_status === "CIRCUIT_OPEN" && <p className="mt-1 text-[11px] text-amber-500">Pausado até {dateTime(provider.circuit_open_until)} · {provider.failure_count} falhas</p>}</div><span className={`rounded-full px-2.5 py-1 text-[11px] ${keyInfo ? "bg-[var(--accent)]/15 text-[var(--accent)]" : "bg-[var(--panel2)] text-[var(--muted)]"}`}>{keyInfo ? `Chave protegida · •••• ${keyInfo.key_suffix}` : "Sem chave"}</span></div>
    <label className="mt-4 block text-xs font-medium">{keyInfo ? "Substituir chave central" : "Cadastrar chave central"}<input value={apiKey} onChange={(event) => setApiKey(event.target.value)} type="password" autoComplete="new-password" spellCheck={false} className="field mt-1 min-h-11 w-full" placeholder="Cole a chave do provider" /></label>
    <div className="mt-2 flex flex-wrap gap-2"><button type="button" disabled={apiKey.trim().length < 16} onClick={saveKey} className="primary min-h-10 rounded-xl px-3 text-xs font-semibold disabled:opacity-50">Salvar chave protegida</button><button type="button" disabled={!keyInfo} onClick={removeKey} className="min-h-10 rounded-xl bg-[var(--panel2)] px-3 text-xs disabled:opacity-50">Remover chave</button></div>
    <p className="muted mt-2 text-[11px] leading-5">A chave fica criptografada no servidor e nunca é devolvida à interface. O teste manual faz uma chamada mínima e pode consumir poucos tokens.</p>
    <section aria-live="polite" className={`mt-3 rounded-xl border p-3 ${waitingForValidation ? "border-amber-500/40 bg-amber-500/5" : "border-[var(--border)] bg-[var(--panel2)]"}`}>
      <p className="text-xs font-semibold">{waitingForValidation ? "Próximo passo: validar a conexão" : `Status: ${statusLabel}`}</p>
      <p className="muted mt-1 text-xs leading-5">{nextStep}</p>
      {canTest && <button type="button" disabled={testing} onClick={testConnection} className="primary mt-3 inline-flex min-h-10 items-center justify-center gap-2 rounded-xl px-4 text-xs font-semibold disabled:cursor-wait disabled:opacity-60">{testing ? <><RefreshCw size={14} className="animate-spin"/>Testando conexão…</> : <><Check size={14}/>{hasCheckedConnection ? "Validar conexão novamente" : "Validar conexão agora"}</>}</button>}
      {canTest && <p className="muted mt-2 text-[11px]">Envia somente uma chamada técnica curta; não usa dados financeiros de usuários.</p>}
    </section>
    <label className="mt-4 flex min-h-11 items-center gap-2 rounded-xl bg-[var(--panel2)] px-3 text-xs"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} className="h-4 w-4 accent-[var(--accent)]"/>Permitir este provider no roteamento</label>
    <div className="mt-2 flex flex-wrap gap-2"><button type="button" disabled={enabled === Boolean(provider?.enabled)} onClick={setProvider} className="min-h-10 rounded-xl bg-[var(--panel2)] px-3 text-xs disabled:opacity-50">{enabled === Boolean(provider?.enabled) ? "Ativação salva" : "Salvar ativação do provider"}</button><button type="button" disabled={!keyInfo} onClick={() => run(() => onPost({ action: "refresh_catalog", provider: id }, "Catálogo atualizado."))} className="min-h-10 rounded-xl bg-[var(--panel2)] px-3 text-xs disabled:opacity-50">Atualizar catálogo</button></div>
    <p className="muted mt-3 text-[11px]">Última validação: {provider?.last_health_check ? dateTime(provider.last_health_check) : "nenhuma executada ainda"}{provider?.last_error_category ? ` · ${errorCategoryLabel(provider.last_error_category)}` : ""}</p>
    <p className="muted mt-2 text-[11px]">Cota oficial reportada: {quotaUsage === null ? quotaStatus : `${quotaUsage.toFixed(0)}% utilizada · ${quotaStatus}`}</p>
    {provider?.quota_headers && Object.keys(provider.quota_headers).length > 0 && <p className="muted mt-1 break-all text-[11px]">Metadados oficiais de cota: {Object.entries(provider.quota_headers).map(([key, value]) => `${key}=${value}`).join(" · ")}</p>}
  </article>;
}

function ModelCard({ model, provider, usage, onPost, run, toast }: { model: Model; provider?: Provider; usage: Array<Record<string, unknown>>; onPost: (payload: Record<string, unknown>, message?: string) => Promise<unknown>; run: (operation: () => Promise<unknown>) => void; toast: (message: string) => void }) {
  const [enabled, setEnabled] = useState(model.is_enabled);
  const [priority, setPriority] = useState(model.priority);
  const [supportsTools, setSupportsTools] = useState(model.supports_tools);
  const [structured, setStructured] = useState(model.supports_structured_output);
  const [reasoning, setReasoning] = useState(model.supports_reasoning);
  const [inputRate, setInputRate] = useState(model.input_cost_per_million == null ? "" : String(model.input_cost_per_million));
  const [outputRate, setOutputRate] = useState(model.output_cost_per_million == null ? "" : String(model.output_cost_per_million));
  const [dailyRequestLimit, setDailyRequestLimit] = useState(model.daily_request_limit == null ? "" : String(model.daily_request_limit));
  const [monthlyRequestLimit, setMonthlyRequestLimit] = useState(model.monthly_request_limit == null ? "" : String(model.monthly_request_limit));
  const [dailyTokenLimit, setDailyTokenLimit] = useState(model.daily_token_limit == null ? "" : String(model.daily_token_limit));
  const [monthlyTokenLimit, setMonthlyTokenLimit] = useState(model.monthly_token_limit == null ? "" : String(model.monthly_token_limit));
  useEffect(() => {
    setEnabled(model.is_enabled); setPriority(model.priority); setSupportsTools(model.supports_tools); setStructured(model.supports_structured_output); setReasoning(model.supports_reasoning);
    setInputRate(model.input_cost_per_million == null ? "" : String(model.input_cost_per_million));
    setOutputRate(model.output_cost_per_million == null ? "" : String(model.output_cost_per_million));
    setDailyRequestLimit(model.daily_request_limit == null ? "" : String(model.daily_request_limit));
    setMonthlyRequestLimit(model.monthly_request_limit == null ? "" : String(model.monthly_request_limit));
    setDailyTokenLimit(model.daily_token_limit == null ? "" : String(model.daily_token_limit));
    setMonthlyTokenLimit(model.monthly_token_limit == null ? "" : String(model.monthly_token_limit));
  }, [model]);
  const numberOrNull = (value: string) => value === "" ? null : Number(value);
  const save = () => run(() => onPost({ action: "update_model", provider: model.provider_id, modelId: model.model_id, isFree: model.is_free, enabled, priority: Number(priority), supportsTools, supportsStructuredOutput: structured, supportsReasoning: reasoning, inputCostPerMillion: numberOrNull(inputRate), outputCostPerMillion: numberOrNull(outputRate), dailyRequestLimit: numberOrNull(dailyRequestLimit), monthlyRequestLimit: numberOrNull(monthlyRequestLimit), dailyTokenLimit: numberOrNull(dailyTokenLimit), monthlyTokenLimit: numberOrNull(monthlyTokenLimit) }, "Configuração do modelo atualizada."));
  const [testing, setTesting] = useState(false);
  const testInFlight = useRef(false);
  const test = () => {
    if (!model.is_enabled || !provider?.enabled || model.provider_id !== "deepseek" || testInFlight.current) return;
    testInFlight.current = true;
    setTesting(true);
    run(async () => {
      try {
        const result = await onPost({ action: "test_model", provider: model.provider_id, modelId: model.model_id });
        toast(connectionSuccessMessage(model.model_id, result));
      } finally {
        testInFlight.current = false;
        setTesting(false);
      }
    });
  };
  return <article className="panel min-w-0 rounded-2xl p-4">
    <div className="flex flex-wrap items-start justify-between gap-2"><div className="min-w-0"><p className="muted text-[10px] uppercase">{names[model.provider_id]}</p><h3 className="mt-1 break-all text-sm font-semibold">{model.display_name}</h3><p className="muted mt-1 break-all text-xs">{model.model_id}</p></div><span className={`rounded-full px-2.5 py-1 text-[10px] font-bold ${model.is_enabled ? "bg-[var(--accent)]/15 text-[var(--accent)]" : "bg-[var(--panel2)] text-[var(--muted)]"}`}>{model.is_free && model.free_verified ? "GRATUITO · metadado confirmado" : "PAGO/SEM PREÇO · estimativa controlada"}</span></div>
    <div className="mt-3 grid gap-1 text-[11px] sm:grid-cols-2 xl:grid-cols-3"><p className="muted">Saúde: {healthLabel(model.health_status, model.last_health_check)} · {model.last_latency_ms === null ? "latência —" : `${model.last_latency_ms} ms`}</p><p className="muted">Contexto: {model.context_window?.toLocaleString("pt-BR") || "não informado"}</p><p className="muted">Custo configurado por 1M: entrada {usd(model.input_cost_per_million)} · saída {usd(model.output_cost_per_million)}</p><p className="muted">Última verificação: {model.last_health_check ? dateTime(model.last_health_check) : "nenhuma executada ainda"}</p><p className="muted">Falhas consecutivas: {model.failure_count}{model.last_error_category ? ` · ${errorCategoryLabel(model.last_error_category)}` : ""}</p><p className="muted">Último catálogo: {dateTime(model.catalog_seen_at)}</p></div>
    <div className="mt-2 flex flex-wrap gap-3 text-[11px]">{usage.map((row) => <span key={String(row.period)} className="muted">Uso {row.period === "day" ? "hoje" : "no mês"}: {Number(row.attempts ?? row.requests ?? 0).toLocaleString("pt-BR")} chamadas · {Number(row.tokens || 0).toLocaleString("pt-BR")} tokens · {usd(row.estimatedCostUsd)} estimados</span>)}</div>
    <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
      <label className="flex min-h-10 items-center gap-2 rounded-lg bg-[var(--panel2)] px-2 text-[11px]"><input type="checkbox" checked={enabled} disabled={!model.supports_chat || (!enabled && (inputRate === "" || outputRate === ""))} onChange={(event) => setEnabled(event.target.checked)} className="h-4 w-4 accent-[var(--accent)]"/>Habilitado no roteador</label>
      <label className="flex min-h-10 items-center gap-2 rounded-lg bg-[var(--panel2)] px-2 text-[11px]">Prioridade<input type="number" min={1} max={1000} value={priority} onChange={(event) => setPriority(Number(event.target.value))} className="field min-h-8 w-20 px-2"/></label>
      <label className="flex min-h-10 items-center gap-2 rounded-lg bg-[var(--panel2)] px-2 text-[11px]"><input type="checkbox" checked={supportsTools} onChange={(event) => setSupportsTools(event.target.checked)} className="h-4 w-4 accent-[var(--accent)]"/>Tool calling</label>
      <label className="flex min-h-10 items-center gap-2 rounded-lg bg-[var(--panel2)] px-2 text-[11px]"><input type="checkbox" checked={structured} onChange={(event) => setStructured(event.target.checked)} className="h-4 w-4 accent-[var(--accent)]"/>Saída estruturada</label>
      <label className="flex min-h-10 items-center gap-2 rounded-lg bg-[var(--panel2)] px-2 text-[11px]"><input type="checkbox" checked={reasoning} onChange={(event) => setReasoning(event.target.checked)} className="h-4 w-4 accent-[var(--accent)]"/>Raciocínio</label>
    </div>
    <div className="mt-3 grid gap-2 sm:grid-cols-2"><DecimalInput label="Custo de entrada por 1M tokens (USD)" value={inputRate} onChange={(value) => setInputRate(value === null ? "" : String(value))}/><DecimalInput label="Custo de saída por 1M tokens (USD)" value={outputRate} onChange={(value) => setOutputRate(value === null ? "" : String(value))}/></div>
    <p className="muted mt-2 text-[11px]">Preços oficiais variam. Configure o valor máximo aplicável e atualize quando a tabela do provider mudar; a métrica permanece identificada como estimativa.</p>
    <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4"><NumberInput label="Limite diário · chamadas (vazio sem limite interno)" value={dailyRequestLimit} nullable onChange={(value) => setDailyRequestLimit(value === null ? "" : String(value))}/><NumberInput label="Limite mensal · chamadas" value={monthlyRequestLimit} nullable onChange={(value) => setMonthlyRequestLimit(value === null ? "" : String(value))}/><NumberInput label="Limite diário · tokens" value={dailyTokenLimit} nullable onChange={(value) => setDailyTokenLimit(value === null ? "" : String(value))}/><NumberInput label="Limite mensal · tokens" value={monthlyTokenLimit} nullable onChange={(value) => setMonthlyTokenLimit(value === null ? "" : String(value))}/></div>
    <div className="mt-3 flex flex-wrap gap-2"><button type="button" onClick={save} className="primary min-h-10 rounded-xl px-3 text-xs font-semibold">Salvar modelo</button><button type="button" disabled={!model.is_enabled || !provider?.enabled || model.provider_id !== "deepseek" || testing} onClick={test} className="min-h-10 rounded-xl bg-[var(--panel2)] px-3 text-xs disabled:opacity-50">{testing ? "Testando conexão…" : "Testar conexão"}</button></div>
  </article>;
}

function UserQuotaCard({ row, onPost, run }: { row: ValAIData["users"][number]; onPost: (payload: Record<string, unknown>, message?: string) => Promise<unknown>; run: (operation: () => Promise<unknown>) => void }) {
  const override = row.override || {};
  const [blocked, setBlocked] = useState(override.is_blocked === true);
  const [dailyRequests, setDailyRequests] = useState(override.daily_requests == null ? "" : String(override.daily_requests));
  const [monthlyRequests, setMonthlyRequests] = useState(override.monthly_requests == null ? "" : String(override.monthly_requests));
  const [dailyTokens, setDailyTokens] = useState(override.daily_tokens == null ? "" : String(override.daily_tokens));
  const [monthlyTokens, setMonthlyTokens] = useState(override.monthly_tokens == null ? "" : String(override.monthly_tokens));
  const [maxContextTokens, setMaxContextTokens] = useState(override.max_context_tokens == null ? "" : String(override.max_context_tokens));
  const [maxOutputTokens, setMaxOutputTokens] = useState(override.max_output_tokens == null ? "" : String(override.max_output_tokens));
  useEffect(() => {
    setBlocked(override.is_blocked === true);
    setDailyRequests(override.daily_requests == null ? "" : String(override.daily_requests));
    setMonthlyRequests(override.monthly_requests == null ? "" : String(override.monthly_requests));
    setDailyTokens(override.daily_tokens == null ? "" : String(override.daily_tokens));
    setMonthlyTokens(override.monthly_tokens == null ? "" : String(override.monthly_tokens));
    setMaxContextTokens(override.max_context_tokens == null ? "" : String(override.max_context_tokens));
    setMaxOutputTokens(override.max_output_tokens == null ? "" : String(override.max_output_tokens));
  }, [override.is_blocked, override.daily_requests, override.monthly_requests, override.daily_tokens, override.monthly_tokens, override.max_context_tokens, override.max_output_tokens]);
  const asNullableNumber = (value: string) => value === "" ? null : Number(value);
  const save = () => run(() => onPost({ action: "set_user_override", userId: row.user.id, blocked, dailyRequests: asNullableNumber(dailyRequests), monthlyRequests: asNullableNumber(monthlyRequests), dailyTokens: asNullableNumber(dailyTokens), monthlyTokens: asNullableNumber(monthlyTokens), maxContextTokens: asNullableNumber(maxContextTokens), maxOutputTokens: asNullableNumber(maxOutputTokens) }, "Limites individuais salvos."));
  const quotaFields: Array<{ label: string; value: string; update: (value: string) => void }> = [
    { label: "Consultas/dia · vazio herda global", value: dailyRequests, update: setDailyRequests },
    { label: "Consultas/mês · vazio herda global", value: monthlyRequests, update: setMonthlyRequests },
    { label: "Tokens/dia · vazio herda global", value: dailyTokens, update: setDailyTokens },
    { label: "Tokens/mês · vazio herda global", value: monthlyTokens, update: setMonthlyTokens },
    { label: "Contexto máximo · vazio herda global", value: maxContextTokens, update: setMaxContextTokens },
    { label: "Saída máxima · vazio herda global", value: maxOutputTokens, update: setMaxOutputTokens },
  ];
  return <article className="panel rounded-2xl p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><b className="block break-words text-sm">{String(row.user.full_name || row.user.username || row.user.id)}</b><p className="muted mt-1 break-all text-[10px]">ID {String(row.user.id)} · {String(row.user.account_status)}</p><p className="muted mt-1 text-xs">Hoje: {Number(row.daily.requests || 0)} consultas · {Number(row.daily.tokens || 0).toLocaleString("pt-BR")} tokens · {usd(row.daily.estimatedCostUsd)} estimados</p><p className="muted mt-1 text-xs">Mês: {Number(row.monthly.requests || 0)} consultas · {Number(row.monthly.tokens || 0).toLocaleString("pt-BR")} tokens · {usd(row.monthly.estimatedCostUsd)} estimados</p></div><label className="flex min-h-10 items-center gap-2 rounded-lg bg-[var(--panel2)] px-3 text-xs"><input type="checkbox" checked={blocked} onChange={(event) => setBlocked(event.target.checked)} className="h-4 w-4 accent-[var(--accent)]"/>Bloquear</label></div><div className="mt-3 grid gap-2 sm:grid-cols-2">{quotaFields.map(({ label, value, update }) => <NumberInput key={label} label={label} value={value} nullable onChange={(next) => update(next === null ? "" : String(next))}/> )}</div><button type="button" onClick={save} className="mt-3 min-h-10 rounded-xl bg-[var(--panel2)] px-3 text-xs">Salvar limite deste usuário</button></article>;
}

function NumberInput({ label, value, onChange, min = 0, max = 1_000_000_000, nullable = false }: { label: string; value: unknown; onChange: (value: number | null) => void; min?: number; max?: number; nullable?: boolean }) {
  const text = value == null ? "" : String(value);
  return <label className="block text-xs">{label}<GroupedIntegerInput value={text} onValueChange={(next) => {
    if (next === "") {
      const emptyValue = nullable ? null : 0;
      if (emptyValue === null || (emptyValue >= min && emptyValue <= max)) onChange(emptyValue);
      return;
    }
    const parsed = parseGroupedInteger(next);
    if (parsed !== null && parsed >= min && parsed <= max) onChange(parsed);
  }} className="field mt-1 min-h-10 w-full" /></label>;
}

function DecimalInput({ label, value, onChange, nullable = false }: { label: string; value: unknown; onChange: (value: number | null) => void; nullable?: boolean }) {
  const text = value == null ? "" : String(value);
  return <label className="block text-xs">{label}<input type="number" min="0" max="100000" step="0.000001" inputMode="decimal" value={text} onChange={(event) => {
    const next = event.target.value;
    if (next === "") { onChange(nullable ? null : 0); return; }
    const parsed = Number(next);
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 100000) onChange(parsed);
  }} className="field mt-1 min-h-10 w-full" /></label>;
}
