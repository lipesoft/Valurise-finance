"use client";

import { useCallback, useEffect, useState } from "react";
import { Bot, Check, ShieldCheck } from "lucide-react";
import { HelpHint } from "@/components/help-hint";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

type ValUsage = {
  today: { requests: number; limit: number; remaining: number };
  month: { requests: number; limit: number; remaining: number; tokens: number };
};

export function ValAISettings({ toast, workspaceId }: { toast: (text: string) => void; workspaceId: string }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [checkingAvailability, setCheckingAvailability] = useState(false);
  const [available, setAvailable] = useState(false);
  const [insightsEnabled, setInsightsEnabled] = useState(false);
  const [actionsEnabled, setActionsEnabled] = useState(false);
  const [actionsAllowed, setActionsAllowed] = useState(false);
  const [renewalRequired, setRenewalRequired] = useState(false);
  const [usage, setUsage] = useState<ValUsage | null>(null);

  const headers = useCallback(async () => {
    const { data } = await getSupabaseBrowserClient()?.auth.getSession() || {};
    const token = data?.session?.access_token;
    return token ? { Authorization: `Bearer ${token}`, "X-Valurise-Workspace-Id": workspaceId } : null;
  }, [workspaceId]);

  const refreshAvailability = useCallback(async (requestHeaders?: Record<string, string>) => {
    const authHeaders = requestHeaders || await headers();
    if (!authHeaders) return null;
    setCheckingAvailability(true);
    try {
      const response = await fetch("/api/personal-ai/connection", { headers: authHeaders, cache: "no-store" });
      const result = await response.json();
      if (!response.ok || !result.connection) return null;
      setAvailable(Boolean(result.connection.available));
      setInsightsEnabled(Boolean(result.connection.insights_enabled));
      setActionsEnabled(Boolean(result.connection.actions_enabled));
      setActionsAllowed(Boolean(result.connection.actions_allowed));
      setRenewalRequired(Boolean(result.connection.consentRenewalRequired));
      return Boolean(result.connection.available);
    } catch {
      return null;
    } finally {
      setCheckingAvailability(false);
    }
  }, [headers]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const requestHeaders = await headers();
        if (!requestHeaders) return;
        const [, usageResponse] = await Promise.all([
          refreshAvailability(requestHeaders),
          fetch("/api/personal-ai/usage", { headers: requestHeaders, cache: "no-store" }),
        ]);
        const usageBody = await usageResponse.json();
        if (cancelled) return;
        if (usageResponse.ok && usageBody.usage) setUsage(usageBody.usage);
      } catch {
        if (!cancelled) setAvailable(false);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [headers, refreshAvailability]);

  useEffect(() => {
    if (loading || available) return;
    const refreshWhenVisible = () => {
      if (document.visibilityState !== "hidden" && !checkingAvailability) void refreshAvailability();
    };
    const interval = window.setInterval(refreshWhenVisible, 15_000);
    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [available, checkingAvailability, loading, refreshAvailability]);

  const save = async () => {
    const requestHeaders = await headers();
    if (!requestHeaders) return toast("Sua sessão expirou. Entre novamente.");
    setSaving(true);
    try {
      const response = await fetch("/api/personal-ai/connection", {
        method: "POST",
        headers: { ...requestHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ insightsEnabled, actionsEnabled: insightsEnabled && actionsEnabled }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Não foi possível salvar suas preferências da Val.");
      setAvailable(Boolean(result.connection?.available));
      setInsightsEnabled(Boolean(result.connection?.insights_enabled));
      setActionsEnabled(Boolean(result.connection?.actions_enabled));
      setActionsAllowed(Boolean(result.connection?.actions_allowed));
      setRenewalRequired(false);
      toast(result.pendingProposalsCancelled ? "Preferências salvas. Propostas antigas foram canceladas." : "Preferências da Val salvas.");
    } catch (error) {
      toast(error instanceof Error ? error.message : "Não foi possível salvar suas preferências.");
    } finally { setSaving(false); }
  };

  const remaining = usage?.today.remaining ?? 0;
  const dailyLimit = usage?.today.limit ?? 0;

  return <section className="panel mt-4 rounded-2xl p-5">
    <div className="flex items-start gap-3">
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[var(--accent)]/15 text-[var(--accent)]"><Bot size={20} aria-hidden="true" /></span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2"><b>Val · sua assistente financeira</b><HelpHint label="Privacidade e funcionamento da Val">
          <p>A Val é administrada pela Valurise. Você não precisa cadastrar chaves nem escolher modelos.</p>
          <p>Quando você autorizar, somente a pergunta e os dados necessários podem ser enviados aos provedores de IA identificados na Política de Privacidade. A Valurise só habilita modelos gratuitos verificados; se não houver um modelo gratuito compatível, a Val pausa sem usar um modelo pago.</p>
          <p>Se permitir propostas financeiras, a Val poderá preparar apenas uma receita ou despesa comum. Nada é registrado até você revisar e confirmar no aplicativo.</p>
        </HelpHint></div>
        <p className="muted mt-1 text-sm">Clareza para decidir hoje. Constância para prosperar amanhã.</p>
      </div>
    </div>

    <div className="mt-4 flex min-h-11 items-center gap-2 rounded-xl bg-[var(--panel2)] px-3 py-2.5 text-sm">
      <span aria-hidden="true" className={`h-2.5 w-2.5 shrink-0 rounded-full ${loading ? "bg-[var(--muted)]" : available ? "bg-[var(--accent)]" : "bg-[var(--danger)]"}`} />
      <span role="status" aria-live="polite" className="min-w-0">{loading ? "Verificando disponibilidade…" : available ? "Val disponível" : "Val temporariamente indisponível"}</span>
      {!loading && !available && <button type="button" disabled={checkingAvailability} onClick={() => void refreshAvailability()} className="ml-auto shrink-0 rounded-lg px-2 py-1 text-xs font-medium text-[var(--accent)] hover:bg-[var(--panel)] disabled:opacity-60">{checkingAvailability ? "Verificando…" : "Verificar agora"}</button>}
    </div>

    {renewalRequired && <p role="status" className="mt-3 rounded-xl bg-[var(--panel2)] p-3 text-xs leading-5">Atualizamos as informações de privacidade da Val. Revise o consentimento abaixo e salve novamente para continuar compartilhando contexto financeiro.</p>}

    <div className="mt-4 space-y-3">
      <label className="flex min-h-14 cursor-pointer items-start gap-3 rounded-xl bg-[var(--panel2)]/70 p-3.5">
        <input type="checkbox" checked={insightsEnabled} onChange={(event) => { setInsightsEnabled(event.target.checked); if (!event.target.checked) setActionsEnabled(false); }} className="mt-0.5 h-5 w-5 shrink-0 accent-[var(--accent)]" />
        <span><span className="block text-sm font-medium">Permitir que a Val consulte meus dados financeiros</span><span className="muted mt-1 block text-xs leading-5">Opcional. A pergunta e os dados estritamente necessários podem ser processados por provedores administrados pela Valurise.</span></span>
      </label>
      <label className={`flex min-h-14 items-start gap-3 rounded-xl bg-[var(--panel2)]/70 p-3.5 ${!insightsEnabled || !actionsAllowed ? "cursor-not-allowed opacity-60" : "cursor-pointer"}`}>
        <input type="checkbox" checked={actionsEnabled && insightsEnabled} disabled={!insightsEnabled || !actionsAllowed} onChange={(event) => setActionsEnabled(event.target.checked)} className="mt-0.5 h-5 w-5 shrink-0 accent-[var(--accent)]" />
        <span><span className="block text-sm font-medium">Permitir propostas de receitas e despesas</span><span className="muted mt-1 block text-xs leading-5">Cada proposta exige sua confirmação explícita antes de criar um lançamento.</span></span>
      </label>
    </div>

    <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="rounded-xl border border-[var(--border)] px-3 py-2.5">
        <div className="flex items-center gap-2"><ShieldCheck size={15} className="text-[var(--accent)]"/><b className="text-xs">Uso hoje</b><HelpHint label="Limite de uso"><p>O limite de consultas da Val é definido pelo Valurise e renovado automaticamente; tokens são medidos separadamente para controle operacional.</p><p>Mesmo com consultas disponíveis, a Val pode aguardar a renovação de um limite temporário do serviço. A disponibilidade é atualizada automaticamente e a Val nunca troca para um modelo pago.</p></HelpHint></div>
        <p className="muted mt-1 text-xs">{usage ? `${remaining} de ${dailyLimit} consultas disponíveis` : "O limite será exibido quando o serviço estiver configurado."}</p>
        {usage && <p className="muted mt-1 text-[11px]">Neste mês: {usage.month.requests.toLocaleString("pt-BR")} consultas</p>}
      </div>
      <button type="button" disabled={saving} onClick={() => void save()} className="primary inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 text-sm font-semibold disabled:opacity-60">{saving ? "Salvando…" : <><Check size={16}/>Salvar preferências</>}</button>
    </div>
  </section>;
}
