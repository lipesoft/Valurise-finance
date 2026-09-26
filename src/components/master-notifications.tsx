"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, ChevronRight, Clock3 } from "lucide-react";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

type RequestNotification = {
  id: string;
  email: string | null;
  full_name: string | null;
  username: string | null;
  created_at: string;
  status: string;
};

type RequestListResponse = {
  items?: RequestNotification[];
  total?: number;
  stats?: Record<string, number>;
};

function dateLabel(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : new Intl.DateTimeFormat("pt-BR", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function MasterNotifications({
  onSelectRequest,
  onRequestsChanged,
}: {
  onSelectRequest: (search: string, userId?: string) => void;
  onRequestsChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<RequestNotification[]>([]);
  const [count, setCount] = useState(0);
  const [waitingForEmail, setWaitingForEmail] = useState(0);
  const [realtimeConnected, setRealtimeConnected] = useState(false);
  const [error, setError] = useState("");
  const [initialLoading, setInitialLoading] = useState(true);
  const requestSequence = useRef(0);
  const lastSnapshot = useRef("");
  const refreshTimer = useRef<number | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);

  const refresh = useCallback(async () => {
    const currentRequest = ++requestSequence.current;
    try {
      const supabase = getSupabaseBrowserClient();
      const { data } = await supabase?.auth.getSession() ?? { data: { session: null } };
      const token = data.session?.access_token;
      if (!token) throw new Error("Sessão Master expirada. Entre novamente.");

      const response = await fetch("/api/admin/users?status=pending&page=1", {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      const payload = await response.json() as RequestListResponse & { error?: string };
      if (!response.ok) throw new Error(payload.error || "Não foi possível atualizar as solicitações.");
      if (currentRequest !== requestSequence.current) return;

      const nextItems = payload.items ?? [];
      const nextCount = Number(payload.stats?.pending ?? payload.total ?? 0);
      const nextWaiting = Number(payload.stats?.email_pending ?? 0);
      const signature = JSON.stringify({
        count: nextCount,
        waiting: nextWaiting,
        items: nextItems.map((item) => [item.id, item.email, item.full_name, item.status, item.created_at]),
      });
      if (!lastSnapshot.current || lastSnapshot.current !== signature) onRequestsChanged();
      lastSnapshot.current = signature;
      setItems(nextItems);
      setCount(nextCount);
      setWaitingForEmail(nextWaiting);
      setError("");
    } catch (cause) {
      if (currentRequest === requestSequence.current) {
        setError(cause instanceof Error ? cause.message : "Não foi possível atualizar as solicitações.");
      }
    } finally {
      if (currentRequest === requestSequence.current) setInitialLoading(false);
    }
  }, [onRequestsChanged]);

  useEffect(() => {
    void refresh();
    const supabase = getSupabaseBrowserClient();
    const channel = supabase && process.env.NEXT_PUBLIC_SUPABASE_REALTIME_ENABLED !== "false"
      ? supabase.channel("valurise-master-request-notifications")
        .on("postgres_changes", { event: "*", schema: "public", table: "access_request_details" }, () => {
          if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current);
          refreshTimer.current = window.setTimeout(() => {
            refreshTimer.current = null;
            void refresh();
          }, 120);
        })
        .subscribe((status) => {
          const connected = status === "SUBSCRIBED";
          setRealtimeConnected(connected);
          if (connected) void refresh();
        })
      : null;

    const poll = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 25_000);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      window.clearInterval(poll);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current);
      if (channel && supabase) void supabase.removeChannel(channel);
    };
  }, [refresh]);

  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    const trigger = triggerRef.current;
    const focusable = () => panel?.querySelectorAll<HTMLElement>("button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex='-1'])");
    const first = focusable()?.[0];
    (first ?? panel)?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const elements = focusable();
      if (!elements?.length) return;
      const firstElement = elements[0];
      const lastElement = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === firstElement) {
        event.preventDefault();
        lastElement.focus();
      } else if (!event.shiftKey && document.activeElement === lastElement) {
        event.preventDefault();
        firstElement.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      if (trigger?.isConnected) trigger.focus();
    };
  }, [open]);

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-label={`Solicitações aguardando análise: ${count}${waitingForEmail ? `; ${waitingForEmail} aguardando confirmação de e-mail` : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="master-notifications-panel"
        onClick={() => setOpen((value) => !value)}
        className="relative grid h-10 w-10 place-items-center rounded-xl bg-[var(--panel2)] text-[var(--fg)] transition-colors hover:text-[var(--accent)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
      >
        <Bell size={18} aria-hidden="true" />
        {count > 0 && <span className="absolute -right-1 -top-1 min-w-5 rounded-full bg-[var(--accent)] px-1 text-center text-[10px] font-bold leading-5 text-[var(--accentfg)]">{count > 99 ? "99+" : count}</span>}
      </button>
      <span className="sr-only" role="status" aria-live="polite">{count > 0 ? `${count} solicitações aguardam análise.` : "Nenhuma solicitação aguarda análise."}{waitingForEmail > 0 ? ` ${waitingForEmail} aguardam confirmação de e-mail.` : ""}</span>

      {open && <section
        ref={panelRef}
        id="master-notifications-panel"
        role="dialog"
        aria-label="Notificações de acesso do Master"
        tabIndex={-1}
        className="panel absolute right-0 top-12 z-50 w-[min(22rem,calc(100vw-2rem))] rounded-2xl p-3 shadow-2xl"
      >
        <div className="flex items-start justify-between gap-3 px-2 py-1">
          <div>
            <h2 className="text-sm font-semibold">Solicitações de acesso</h2>
            <p className="muted mt-1 text-[11px]">{realtimeConnected ? "Atualizações ao vivo" : "Atualização automática periódica"}</p>
          </div>
          <span className="rounded-full bg-[var(--accent)] px-2 py-1 text-xs font-bold text-[var(--accentfg)]">{count}</span>
        </div>

        {error && <p role="status" className="mx-2 mt-3 rounded-xl bg-[var(--danger)]/10 p-3 text-xs text-[var(--danger)]">{error}</p>}
        {initialLoading && <p role="status" className="muted px-2 py-4 text-xs">Carregando solicitações…</p>}
        {!initialLoading && items.length === 0 && <p className="muted px-2 py-4 text-xs">Nenhuma solicitação confirmada aguardando análise.{waitingForEmail > 0 ? ` ${waitingForEmail} ainda aguardam confirmação do e-mail.` : ""}</p>}

        <div className="mt-2 max-h-72 space-y-1 overflow-y-auto">
          {items.slice(0, 5).map((item) => <button
            type="button"
            key={item.id}
            onClick={() => {
              setOpen(false);
              onSelectRequest(item.email || item.username || "", item.id);
            }}
            className="flex min-h-14 w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-[var(--panel2)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
          >
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[var(--accent)]/10 text-[var(--accent)]"><Bell size={14} aria-hidden="true" /></span>
            <span className="min-w-0 flex-1">
              <b className="block truncate text-xs">{item.full_name || item.email || "Novo cadastro"}</b>
              <small className="muted mt-0.5 block truncate">{item.email || "E-mail indisponível"} · {dateLabel(item.created_at)}</small>
            </span>
            <ChevronRight size={15} className="muted shrink-0" aria-hidden="true" />
          </button>)}
        </div>

        <div className="mt-2 border-t border-[var(--border)] pt-2">
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onSelectRequest("", undefined);
            }}
            className="flex min-h-11 w-full items-center justify-between rounded-xl px-2.5 text-xs font-semibold text-[var(--accent)] hover:bg-[var(--panel2)]"
          >
            Ver fila completa <ChevronRight size={15} aria-hidden="true" />
          </button>
          {waitingForEmail > 0 && <p className="muted flex items-center gap-1.5 px-2.5 pb-1 text-[10px]"><Clock3 size={12} aria-hidden="true" />{waitingForEmail} aguardando confirmação do e-mail</p>}
        </div>
      </section>}
    </div>
  );
}
