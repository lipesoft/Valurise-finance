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

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const requestHeaders = await headers();
        if (!requestHeaders) return;
        const [connectionResponse, usageResponse] = await Promise.all([
          fetch("/api/personal-ai/connection", { headers: requestHeaders, cache: "no-store" }),
          fetch("/api/personal-ai/usage", { headers: requestHeaders, cache: "no-store" }),
        ]);
        const [connectionBody, usageBody] = await Promise.all([connectionResponse.json(), usageResponse.json()]);
        if (cancelled) return;
        if (connectionResponse.ok && connectionBody.connection) {
          setAvailable(Boolean(connectionBody.connection.available));
          setInsightsEnabled(Boolean(connectionBody.connection.insights_enabled));
          setActionsEnabled(Boolean(connectionBody.connection.actions_enabled));
          setActionsAllowed(Boolean(connectionBody.connection.actions_allowed));
          setRenewalRequired(Boolean(connectionBody.connection.consentRenewalRequired));
        }
        if (usageResponse.ok && usageBody.usage) setUsage(usageBody.usage);
      } catch {
        if (!cancelled) setAvailable(false);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [headers]);

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

    <div className="mt-4 flex items-center gap-2 rounded-xl bg-[var(--panel2)] px-3 py-2.5 text-sm" role="status" aria-live="polite">
      <span aria-hidden="true" className={`h-2.5 w-2.5 rounded-full ${loading ? "bg-[var(--muted)]" : available ? "bg-[var(--accent)]" : "bg-[var(--danger)]"}`} />
      <span>{loading ? "Verificando disponibilidade…" : available ? "Val disponível" : "Val temporariamente indisponível"}</span>
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
        <div className="flex items-center gap-2"><ShieldCheck size={15} className="text-[var(--accent)]"/><b className="text-xs">Uso hoje</b><HelpHint label="Limite de uso"><p>O limite é definido pelo Valurise e renovado automaticamente. Métricas internas de tokens servem somente para segurança e controle operacional.</p></HelpHint></div>
        <p className="muted mt-1 text-xs">{usage ? `${remaining} de ${dailyLimit} consultas disponíveis` : "O limite será exibido quando o serviço estiver configurado."}</p>
        {usage && <p className="muted mt-1 text-[11px]">Neste mês: {usage.month.requests.toLocaleString("pt-BR")} consultas</p>}
      </div>
      <button type="button" disabled={saving} onClick={() => void save()} className="primary inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 text-sm font-semibold disabled:opacity-60">{saving ? "Salvando…" : <><Check size={16}/>Salvar preferências</>}</button>
    </div>
  </section>;
}
