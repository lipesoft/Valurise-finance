"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  Bell,
  Check,
  ChevronLeft,
  ChevronRight,
  Clipboard,
  Clock3,
  Copy,
  MailCheck,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

type Section = "requests" | "users" | "invites" | "audit";
type Account = {
  id: string;
  email: string | null;
  email_confirmed_at: string | null;
  last_sign_in_at: string | null;
  created_at: string;
  full_name: string | null;
  username: string | null;
  role: string;
  stored_status: string;
  request_status: string | null;
  requested_at: string;
  invite_id: string | null;
  invite_state: string;
  status: string;
};
type PageData = { items: Account[]; total: number; page: number; pageSize: number; stats: Record<string, number> };
type Invite = { id: string; token: string; link: string; createdAt: string; expiresAt: string; usedAt: string | null; usedByName: string | null; revokedAt: string | null; status: string };
type AuditEntry = { id: string; action: string; outcome: string; reason_code: string | null; reason_note: string | null; detail_code: string | null; created_at: string; actor_name: string | null; actor_email: string | null; target_ref: string | null; target_name: string | null; target_email: string | null };
type PendingAction = { user: Account; action: "approve" | "reject" | "disable" | "restore" | "trash" | "archive_request" | "reopen_request" | "delete_permanently" };
type RequestTarget = { search: string; userId?: string; nonce: number };

const pageSize = 25;
const sections: { id: Section; label: string; icon: typeof Bell }[] = [
  { id: "requests", label: "Solicitações", icon: Bell },
  { id: "users", label: "Usuários", icon: Users },
  { id: "invites", label: "Convites", icon: MailCheck },
  { id: "audit", label: "Auditoria", icon: Activity },
];
const statusLabels: Record<string, string> = {
  pending: "Aguardando análise",
  pending_email: "Aguardando confirmação do e-mail",
  verification_required: "Precisa validar o acesso",
  active: "Ativa",
  disabled: "Desativada",
  trashed: "Na lixeira",
  rejected: "Recusada",
};
const actionLabels: Record<string, string> = {
  approved: "Acesso aprovado",
  rejected: "Solicitação recusada",
  disabled: "Conta desativada",
  restored: "Conta restaurada",
  trashed: "Conta movida para lixeira",
  permanently_deleted: "Conta excluída definitivamente",
  invite_created: "Convite criado",
  invite_revoked: "Convite cancelado",
};
const outcomeLabels: Record<string, string> = {
  started: "Em andamento",
  completed: "Concluída",
  failed: "Falhou — pode ser tentada novamente",
  needs_attention: "Precisa de atenção",
};
const reasonLabels: Record<string, string> = {
  duplicate_request: "Solicitação duplicada",
  incomplete_request: "Informações incompletas",
  policy_violation: "Violação de política",
  security_concern: "Preocupação de segurança",
  user_requested: "Pedido do usuário",
  other: "Outro motivo",
};

function dateLabel(value?: string | null) {
  if (!value) return "Ainda não ocorreu";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat("pt-BR", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function accountName(account: Account) {
  return account.full_name || account.email || "Usuário";
}

function auditActionLabel(entry: AuditEntry) {
  if (entry.action === "trashed" && entry.reason_note?.startsWith("Solicitação confirmada arquivada:")) return "Solicitação arquivada";
  if (entry.action === "restored" && entry.reason_note?.startsWith("Solicitação arquivada reaberta:")) return "Solicitação reaberta para análise";
  return actionLabels[entry.action] || entry.action;
}

function dateInputStart(value: string): string | undefined {
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return undefined;
  const date = new Date(year, month - 1, day);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function dateInputEndExclusive(value: string): string | undefined {
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return undefined;
  const date = new Date(year, month - 1, day + 1);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function MasterAdminPanel({
  toast,
  requestRevision,
  requestTarget,
}: {
  toast: (text: string) => void;
  requestRevision: number;
  requestTarget: RequestTarget | null;
}) {
  const [section, setSection] = useState<Section>("requests");
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [requestTotalPages, setRequestTotalPages] = useState(1);
  const [stats, setStats] = useState<Record<string, number>>({});
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [auditFilter, setAuditFilter] = useState("");
  const [auditOutcome, setAuditOutcome] = useState("");
  const [auditSince, setAuditSince] = useState("");
  const [auditUntil, setAuditUntil] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [newInviteLink, setNewInviteLink] = useState("");
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [reasonCode, setReasonCode] = useState("other");
  const [reasonNote, setReasonNote] = useState("");
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [deletePassword, setDeletePassword] = useState("");
  const [focusRequestId, setFocusRequestId] = useState<string | null>(null);
  const requestSequence = useRef(0);
  const loadRef = useRef<() => Promise<void>>(async () => undefined);
  const dialogRef = useRef<HTMLElement | null>(null);
  const modalOpener = useRef<HTMLButtonElement | null>(null);
  const busyRef = useRef<string | null>(null);

  const closeActionDialog = useCallback(() => {
    setPendingAction(null);
    setDeletePassword("");
    setDeleteConfirmation("");
  }, []);

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  const getToken = useCallback(async () => {
    const supabase = getSupabaseBrowserClient();
    const { data } = await supabase?.auth.getSession() ?? { data: { session: null } };
    return data.session?.access_token ?? null;
  }, []);

  const load = useCallback(async () => {
    const currentRequest = ++requestSequence.current;
    setLoading(true);
    try {
      if (section === "audit" && auditSince && auditUntil && auditSince > auditUntil) {
        setAudit([]);
        setTotal(0);
        return;
      }
      const token = await getToken();
      if (!token) throw new Error("Sua sessão expirou. Entre novamente no painel Master.");
      const headers = { Authorization: "Bearer " + token };
      const query = new URLSearchParams({ search: search.trim(), page: String(page) });
      if (section === "requests") {
        query.set("status", "requests");
        const response = await fetch("/api/admin/users?" + query.toString(), { headers, cache: "no-store" });
        const body = await response.json() as PageData;
        if (!response.ok) throw new Error((body as PageData & { error?: string }).error || "Não foi possível carregar as solicitações.");
        if (currentRequest !== requestSequence.current) return;
        setAccounts(body.items ?? []);
        setTotal(body.total ?? 0);
        setRequestTotalPages(Math.max(1, Math.ceil((body.total ?? 0) / pageSize)));
        setStats(body.stats ?? {});
      } else if (section === "users") {
        query.set("status", status);
        const response = await fetch("/api/admin/users?" + query.toString(), { headers, cache: "no-store" });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "Não foi possível carregar as contas.");
        if (currentRequest !== requestSequence.current) return;
        setAccounts(body.items ?? []);
        setTotal(body.total ?? 0);
        setStats(body.stats ?? {});
      } else if (section === "invites") {
        const response = await fetch("/api/admin/invites?page=" + page, { headers, cache: "no-store" });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "Não foi possível carregar os convites.");
        if (currentRequest !== requestSequence.current) return;
        setInvites(body.items ?? []);
        setTotal(body.total ?? 0);
      } else {
        const params = new URLSearchParams({ page: String(page) });
        if (auditFilter) params.set("action", auditFilter);
        if (auditOutcome) params.set("outcome", auditOutcome);
        const since = dateInputStart(auditSince);
        const until = dateInputEndExclusive(auditUntil);
        if (since) params.set("since", since);
        if (until) params.set("until", until);
        const response = await fetch("/api/admin/audit?" + params.toString(), { headers, cache: "no-store" });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "Não foi possível carregar a auditoria.");
        if (currentRequest !== requestSequence.current) return;
        setAudit(body.items ?? []);
        setTotal(body.total ?? 0);
      }
    } catch (error) {
      if (currentRequest === requestSequence.current) toast(error instanceof Error ? error.message : "Não foi possível atualizar o painel.");
    } finally {
      if (currentRequest === requestSequence.current) setLoading(false);
    }
  }, [auditFilter, auditOutcome, auditSince, auditUntil, getToken, page, search, section, status, toast]);

  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), search ? 240 : 0);
    return () => window.clearTimeout(timer);
  }, [load, search]);

  useEffect(() => {
    if (!requestTarget) return;
    setSection("requests");
    setPage(1);
    setSearch(requestTarget.search);
    setFocusRequestId(requestTarget.userId ?? null);
  }, [requestTarget]);

  useEffect(() => {
    if (!requestRevision || section !== "requests") return;
    void loadRef.current();
  }, [requestRevision, section]);

  useEffect(() => {
    if (!focusRequestId || section !== "requests" || loading) return;
    const target = document.getElementById(`master-request-${focusRequestId}`);
    if (!target) return;
    target.setAttribute("tabindex", "-1");
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.focus({ preventScroll: true });
    setFocusRequestId(null);
  }, [accounts, focusRequestId, loading, section]);

  useEffect(() => {
    if (!pendingAction) return;
    const dialog = dialogRef.current;
    const opener = modalOpener.current;
    const focusable = () => dialog?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    const first = focusable()?.[0];
    first?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busyRef.current) {
        event.preventDefault();
        closeActionDialog();
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
      if (opener?.isConnected) opener.focus();
      modalOpener.current = null;
    };
  }, [closeActionDialog, pendingAction]);

  const actionableRequests = useMemo(() => accounts.filter((account) => account.status === "pending"), [accounts]);
  const waitingForEmail = useMemo(() => accounts.filter((account) => account.status === "pending_email" || account.status === "verification_required"), [accounts]);
  const totalPages = section === "requests" ? requestTotalPages : Math.max(1, Math.ceil(total / pageSize));

  const chooseAction = (user: Account, action: PendingAction["action"], trigger?: HTMLButtonElement) => {
    setReasonCode(action === "delete_permanently" ? "user_requested" : action === "restore" ? "user_requested" : "other");
    setReasonNote("");
    setDeleteConfirmation("");
    setDeletePassword("");
    modalOpener.current = trigger ?? null;
    setPendingAction({ user, action });
  };

  const executeAction = async (action: PendingAction, reason?: { code: string; note: string }, reauthPassword?: string) => {
    const token = await getToken();
    if (!token) return toast("Sua sessão expirou. Entre novamente no painel Master.");
    setBusy(action.user.id + ":" + action.action);
    try {
      const response = await fetch("/api/admin/users", {
        method: "POST",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: action.user.id,
          action: action.action,
          ...(reason ? { reasonCode: reason.code, reasonNote: reason.note || undefined } : {}),
          ...(action.action === "delete_permanently" && reauthPassword ? { reauthPassword } : {}),
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Não foi possível concluir a ação.");
      const messages: Record<PendingAction["action"], string> = {
        approve: "Acesso aprovado.",
        reject: "Solicitação recusada.",
        disable: "Conta desativada.",
        restore: "Conta restaurada.",
        trash: "Conta movida para a lixeira.",
        archive_request: "Solicitação arquivada na lixeira sem ser recusada.",
        reopen_request: "Solicitação reaberta e devolvida para análise.",
        delete_permanently: "Conta excluída definitivamente.",
      };
      toast(messages[action.action]);
      setPendingAction(null);
      setDeletePassword("");
      setDeleteConfirmation("");
      setPage(1);
      await load();
    } catch (error) {
      toast(error instanceof Error ? error.message : "Não foi possível concluir a ação.");
    } finally {
      setBusy(null);
      if (action.action === "delete_permanently") setDeletePassword("");
    }
  };

  const createInvite = async () => {
    const token = await getToken();
    if (!token) return toast("Sua sessão expirou. Entre novamente no painel Master.");
    setBusy("invite:create");
    try {
      const response = await fetch("/api/admin/invites", { method: "POST", headers: { Authorization: "Bearer " + token } });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Não foi possível gerar o convite.");
      setNewInviteLink(body.invite.link);
      toast("Convite criado. Ele vale por 7 dias e ainda exige aprovação.");
      await load();
    } catch (error) {
      toast(error instanceof Error ? error.message : "Não foi possível gerar o convite.");
    } finally {
      setBusy(null);
    }
  };

  const revokeInvite = async (inviteId: string) => {
    const token = await getToken();
    if (!token) return toast("Sua sessão expirou. Entre novamente no painel Master.");
    setBusy("invite:" + inviteId);
    try {
      const response = await fetch("/api/admin/invites", {
        method: "DELETE",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify({ inviteId }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Não foi possível cancelar o convite.");
      toast("Convite cancelado.");
      await load();
    } catch (error) {
      toast(error instanceof Error ? error.message : "Não foi possível cancelar o convite.");
    } finally {
      setBusy(null);
    }
  };

  const copyLink = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast("Link copiado.");
    } catch {
      toast("Não foi possível copiar automaticamente. Selecione e copie o link.");
    }
  };

  const accountCard = (account: Account, request = false) => {
    const statusColor = account.status === "pending" ? "text-[var(--accent)]" : account.status === "trashed" || account.status === "rejected" ? "text-[var(--danger)]" : "muted";
    const rowBusy = busy?.startsWith(account.id + ":") ?? false;
    return <article id={request ? `master-request-${account.id}` : undefined} key={account.id} className="rounded-2xl border border-[var(--border)] bg-[var(--panel2)]/55 p-4 sm:p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <b className="block truncate text-sm">{accountName(account)}</b>
          <small className="muted mt-1 block truncate">{account.email || "E-mail indisponível"}</small>
          {account.username && <small className="muted mt-1 block truncate">@{account.username}</small>}
          <span className={"mt-2 inline-flex items-center gap-1.5 text-xs " + statusColor}>
            {account.status === "pending_email" ? <MailCheck size={14}/> : account.status === "verification_required" ? <Clock3 size={14}/> : <ShieldCheck size={14}/>}
            {statusLabels[account.status] || account.status}
          </span>
          {request && <small className="muted mt-1 block text-[11px]">E-mail confirmado{account.email_confirmed_at ? ` em ${dateLabel(account.email_confirmed_at)}` : ""}{account.invite_id ? " · Cadastro por convite" : " · Cadastro aberto"}</small>}
          <small className="muted mt-1 block text-[11px]">Criada em {dateLabel(account.created_at)}{account.last_sign_in_at ? " · Acesso recente: " + dateLabel(account.last_sign_in_at) : ""}</small>
        </div>
        <div className="flex flex-wrap gap-2 sm:justify-end">
          {request && account.status === "pending" && <>
            <button type="button" disabled={rowBusy} onClick={(event) => chooseAction(account, "approve", event.currentTarget)} className="min-h-10 rounded-xl bg-[var(--accent)] px-3.5 text-xs font-semibold text-[var(--accentfg)] disabled:opacity-50"><Check className="mr-1 inline" size={14}/>Aprovar</button>
            <button type="button" disabled={rowBusy} onClick={(event) => chooseAction(account, "reject", event.currentTarget)} className="min-h-10 rounded-xl border border-[var(--danger)]/30 px-3.5 text-xs font-medium text-[var(--danger)] disabled:opacity-50">Recusar</button>
            <button type="button" disabled={rowBusy} onClick={(event) => chooseAction(account, "archive_request", event.currentTarget)} className="min-h-10 rounded-xl bg-[var(--panel)] px-3.5 text-xs font-medium disabled:opacity-50">Arquivar solicitação</button>
          </>}
          {!request && account.role !== "master" && account.status === "active" && <>
            <button type="button" disabled={rowBusy} onClick={(event) => chooseAction(account, "disable", event.currentTarget)} className="min-h-10 rounded-xl bg-[var(--panel)] px-3 text-xs disabled:opacity-50">Desativar</button>
            <button type="button" disabled={rowBusy} onClick={(event) => chooseAction(account, "trash", event.currentTarget)} className="min-h-10 rounded-xl border border-[var(--danger)]/25 px-3 text-xs text-[var(--danger)] disabled:opacity-50">Mover para lixeira</button>
          </>}
          {!request && account.role !== "master" && (account.status === "disabled" || account.status === "rejected") && <>
            {account.status === "disabled" && <button type="button" disabled={rowBusy} onClick={(event) => chooseAction(account, "restore", event.currentTarget)} className="min-h-10 rounded-xl bg-[var(--panel)] px-3 text-xs disabled:opacity-50">Reativar</button>}
            <button type="button" disabled={rowBusy} onClick={(event) => chooseAction(account, "trash", event.currentTarget)} className="min-h-10 rounded-xl border border-[var(--danger)]/25 px-3 text-xs text-[var(--danger)] disabled:opacity-50">Mover para lixeira</button>
          </>}
          {!request && account.role !== "master" && account.status === "trashed" && <>
            {account.request_status === "pending_review"
              ? <button type="button" disabled={rowBusy} onClick={(event) => chooseAction(account, "reopen_request", event.currentTarget)} className="min-h-10 rounded-xl bg-[var(--panel)] px-3 text-xs text-[var(--accent)] disabled:opacity-50">Reabrir solicitação</button>
              : account.request_status !== "rejected" && <button type="button" disabled={rowBusy} onClick={(event) => chooseAction(account, "restore", event.currentTarget)} className="min-h-10 rounded-xl bg-[var(--panel)] px-3 text-xs disabled:opacity-50">Restaurar</button>}
            <button type="button" disabled={rowBusy} onClick={(event) => chooseAction(account, "delete_permanently", event.currentTarget)} className="min-h-10 rounded-xl border border-[var(--danger)]/35 px-3 text-xs text-[var(--danger)] disabled:opacity-50"><Trash2 className="mr-1 inline" size={14}/>Excluir definitivamente</button>
          </>}
          {!request && account.status === "trashed" && account.request_status === "pending_review" && <small className="muted block w-full text-xs">Pedido arquivado — ainda não aprovado nem recusado.</small>}
        </div>
      </div>
    </article>;
  };

  const pageControls = <div className="flex items-center justify-between gap-3 border-t border-[var(--border)] pt-4">
    <span className="muted text-xs">{total === 0 ? "Nenhum registro" : "Página " + page + " de " + totalPages + " · " + total + " registros"}</span>
    <div className="flex gap-2"><button type="button" aria-label="Página anterior" disabled={page <= 1 || loading} onClick={() => setPage((value) => Math.max(1, value - 1))} className="grid h-11 w-11 place-items-center rounded-xl bg-[var(--panel2)] disabled:opacity-40"><ChevronLeft size={16}/></button><button type="button" aria-label="Próxima página" disabled={page >= totalPages || loading} onClick={() => setPage((value) => Math.min(totalPages, value + 1))} className="grid h-11 w-11 place-items-center rounded-xl bg-[var(--panel2)] disabled:opacity-40"><ChevronRight size={16}/></button></div>
  </div>;

  return <section>
    <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
      <div><div className="flex items-center gap-2"><b className="text-lg">Acesso e contas</b>{Number(stats.pending) > 0 && <span className="rounded-full bg-[var(--accent)] px-2.5 py-1 text-[10px] font-bold text-[var(--accentfg)]">{stats.pending} para analisar</span>}</div><p className="muted mt-1 max-w-2xl text-xs leading-5">Gerencie cadastro e acesso. O painel não consulta nem exibe dados financeiros dos usuários.</p></div>
      <button type="button" disabled={loading} onClick={() => void load()} className="inline-flex min-h-10 items-center justify-center gap-2 self-start rounded-xl bg-[var(--panel2)] px-3 text-xs text-[var(--accent)] disabled:opacity-50"><RefreshCw className={loading ? "animate-spin" : ""} size={14}/>Atualizar</button>
    </div>

    <nav aria-label="Seções do painel Master" className="sticky top-[64px] z-10 -mx-1 mt-5 grid grid-cols-2 gap-2 rounded-2xl border border-[var(--border)] bg-[var(--panel)]/95 p-2 backdrop-blur sm:static sm:mx-0 sm:flex sm:flex-wrap sm:border-0 sm:bg-transparent sm:p-0 sm:backdrop-blur-none">
      {sections.map(({ id, label, icon: Icon }) => <button type="button" key={id} aria-current={section === id ? "page" : undefined} onClick={() => { setSection(id); setPage(1); setSearch(""); }} className={"inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-3 text-xs font-medium transition-colors sm:px-4 " + (section === id ? "bg-[var(--accent)] text-[var(--accentfg)]" : "bg-[var(--panel2)] text-[var(--muted)] hover:text-[var(--fg)]")}><Icon size={15}/>{label}{id === "requests" && Number(stats.pending) > 0 && <span className="rounded-full bg-black/10 px-1.5 py-0.5 text-[10px]">{stats.pending}</span>}</button>)}
    </nav>

    {section === "requests" && <div className="mt-5 space-y-6">
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[["Para analisar", stats.pending], ["Confirmar e-mail", stats.email_pending], ["Contas ativas", stats.active], ["Na lixeira", stats.trashed]].map(([label, value]) => <div key={String(label)} className="rounded-xl bg-[var(--panel2)]/70 px-3 py-3"><dt className="muted text-[11px]">{label}</dt><dd className="mt-1 text-lg font-semibold tabular-nums">{Number(value ?? 0).toLocaleString("pt-BR")}</dd></div>)}
      </dl>
      <label className="relative block"><span className="sr-only">Buscar solicitações por nome, usuário ou e-mail</span><Search aria-hidden="true" size={16} className="muted absolute left-3 top-1/2 -translate-y-1/2"/><input value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} className="field min-h-11 w-full pl-10" placeholder="Buscar solicitações por nome, usuário ou e-mail" /></label>
      <section className="rounded-2xl border border-[var(--accent)]/25 bg-[var(--accent)]/5 p-4 sm:p-5">
        <div className="flex items-start justify-between gap-3"><div><h2 className="flex items-center gap-2 text-sm font-semibold"><Bell size={16} className="text-[var(--accent)]"/>Prontas para análise</h2><p className="muted mt-1 text-xs">Só entram aqui cadastros que confirmaram o e-mail.</p></div><span className="rounded-full bg-[var(--accent)] px-2.5 py-1 text-xs font-bold text-[var(--accentfg)]">{stats.pending ?? 0}</span></div>
        <div className="mt-4 space-y-2">{actionableRequests.map((account) => accountCard(account, true))}{!loading && actionableRequests.length === 0 && <p className="muted rounded-xl bg-[var(--panel)]/60 p-4 text-xs">{Number(stats.pending) > 0 ? "Há outros pedidos em páginas diferentes da fila." : "Nenhuma solicitação confirmada aguardando decisão."}</p>}</div>
      </section>
      <section className="rounded-2xl border border-[var(--border)] p-4 sm:p-5">
        <div className="flex items-start justify-between gap-3"><div><h2 className="flex items-center gap-2 text-sm font-semibold"><Clock3 size={16} className="muted"/>Ainda não podem ser decididas</h2><p className="muted mt-1 text-xs">A pessoa precisa confirmar o e-mail ou validar novamente um cadastro antigo.</p></div><span className="rounded-full bg-[var(--panel2)] px-2.5 py-1 text-xs">{stats.email_pending ?? 0}</span></div>
        <div className="mt-4 space-y-2">{waitingForEmail.map((account) => accountCard(account, true))}{!loading && waitingForEmail.length === 0 && <p className="muted rounded-xl bg-[var(--panel2)]/50 p-4 text-xs">{Number(stats.email_pending) > 0 ? "Há cadastros aguardando confirmação em outras páginas." : "Não há cadastros aguardando confirmação de e-mail."}</p>}</div>
      </section>
      {pageControls}
    </div>}

    {section === "users" && <div className="mt-5 space-y-4">
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_200px]">
        <label className="relative block"><span className="sr-only">Buscar por nome, usuário ou e-mail</span><Search aria-hidden="true" size={16} className="muted absolute left-3 top-1/2 -translate-y-1/2"/><input value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} className="field min-h-11 w-full pl-10" placeholder="Buscar nome, usuário ou e-mail" /></label>
        <label className="sr-only" htmlFor="master-account-status">Filtrar contas</label><select id="master-account-status" value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }} className="field min-h-11"><option value="all">Todos os estados</option><option value="active">Ativas</option><option value="disabled">Desativadas</option><option value="trashed">Na lixeira</option><option value="rejected">Recusadas</option><option value="pending">Aguardando análise</option><option value="pending_email">Confirmação pendente</option><option value="verification_required">Validação necessária</option></select>
      </div>
      <div className="space-y-2">{accounts.map((account) => accountCard(account))}{!loading && accounts.length === 0 && <div className="rounded-2xl bg-[var(--panel2)]/50 p-8 text-center"><Users className="muted mx-auto" size={22}/><p className="mt-3 text-sm">Nenhuma conta encontrada</p><p className="muted mt-1 text-xs">Tente outro nome, e-mail ou filtro.</p></div>}</div>
      {pageControls}
    </div>}

    {section === "invites" && <div className="mt-5 space-y-4">
      <div className="flex flex-col justify-between gap-3 rounded-2xl bg-[var(--panel2)] p-4 sm:flex-row sm:items-center sm:p-5"><div><h2 className="text-sm font-semibold">Convites de cadastro</h2><p className="muted mt-1 text-xs">O link expira em 7 dias; o convite não substitui confirmação de e-mail nem aprovação.</p></div><button type="button" disabled={busy === "invite:create"} onClick={() => void createInvite()} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-[var(--accent)] px-4 text-xs font-semibold text-[var(--accentfg)] disabled:opacity-50"><Plus size={15}/>{busy === "invite:create" ? "Gerando…" : "Gerar convite"}</button></div>
      {newInviteLink && <div className="rounded-2xl border border-[var(--accent)]/25 bg-[var(--accent)]/5 p-4"><label className="text-xs font-medium" htmlFor="new-master-invite">Link criado</label><div className="mt-2 flex flex-col gap-2 sm:flex-row"><input id="new-master-invite" readOnly value={newInviteLink} className="field min-h-11 min-w-0 flex-1 text-xs"/><button type="button" onClick={() => void copyLink(newInviteLink)} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-[var(--panel2)] px-3 text-xs"><Copy size={14}/>Copiar</button></div></div>}
      <div className="space-y-2">{invites.map((invite) => <article key={invite.id} className="rounded-2xl border border-[var(--border)] p-4"><div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div className="min-w-0"><b className="text-sm">{invite.status === "active" ? "Convite ativo" : invite.status === "used" ? "Utilizado" : invite.status === "revoked" ? "Cancelado" : "Expirado"}</b><small className="muted mt-1 block">Criado {dateLabel(invite.createdAt)} · Expira {dateLabel(invite.expiresAt)}</small>{invite.usedByName && <small className="muted mt-1 block">Usado por {invite.usedByName}</small>}</div><div className="flex flex-wrap gap-2">{invite.status === "active" && <><button type="button" onClick={() => void copyLink(invite.link)} className="min-h-10 rounded-xl bg-[var(--panel2)] px-3 text-xs"><Copy className="mr-1 inline" size={14}/>Copiar link</button><button type="button" disabled={busy === "invite:" + invite.id} onClick={() => void revokeInvite(invite.id)} className="min-h-10 rounded-xl border border-[var(--danger)]/30 px-3 text-xs text-[var(--danger)] disabled:opacity-50">Cancelar</button></>}</div></div></article>)}{!loading && invites.length === 0 && <p className="muted rounded-2xl bg-[var(--panel2)]/50 p-8 text-center text-sm">Nenhum convite criado ainda.</p>}</div>
      {pageControls}
    </div>}

    {section === "audit" && <div className="mt-5 space-y-4">
      <div><h2 className="text-sm font-semibold">Histórico administrativo</h2><p className="muted mt-1 text-xs">As decisões do Master ficam registradas com resultado e motivo.</p></div>
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <label className="block text-xs">Ação<select id="master-audit-filter" value={auditFilter} onChange={(event) => { setAuditFilter(event.target.value); setPage(1); }} className="field mt-1 min-h-11 w-full"><option value="">Todas as ações</option>{Object.entries(actionLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label className="block text-xs">Resultado<select id="master-audit-outcome" value={auditOutcome} onChange={(event) => { setAuditOutcome(event.target.value); setPage(1); }} className="field mt-1 min-h-11 w-full"><option value="">Todos os resultados</option>{Object.entries(outcomeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label className="block text-xs">A partir de<input id="master-audit-since" type="date" value={auditSince} onChange={(event) => { setAuditSince(event.target.value); setPage(1); }} className="field mt-1 min-h-11 w-full" /></label>
        <label className="block text-xs">Até<input id="master-audit-until" type="date" value={auditUntil} onChange={(event) => { setAuditUntil(event.target.value); setPage(1); }} className="field mt-1 min-h-11 w-full" /></label>
      </div>
      {auditSince && auditUntil && auditSince > auditUntil && <p role="alert" className="text-xs text-[var(--danger)]">A data inicial deve ser anterior ou igual à data final.</p>}
      {(auditFilter || auditOutcome || auditSince || auditUntil) && <button type="button" onClick={() => { setAuditFilter(""); setAuditOutcome(""); setAuditSince(""); setAuditUntil(""); setPage(1); }} className="min-h-10 rounded-xl bg-[var(--panel2)] px-3 text-xs">Limpar filtros</button>}
      <div className="space-y-2">{audit.map((entry) => {
        const retryActions: Partial<Record<string, PendingAction["action"]>> = {
          approved: "approve", rejected: "reject", disabled: "disable", restored: "restore", trashed: "trash", permanently_deleted: "delete_permanently",
        };
        const expectedDetail: Record<string, string> = {
          approved: "auth_unban_failed", rejected: "auth_ban_failed", disabled: "auth_ban_failed", restored: "auth_unban_failed", trashed: "auth_ban_failed", permanently_deleted: "auth_delete_failed",
        };
        const isArchivedRequest = entry.action === "trashed" && entry.reason_note?.startsWith("Solicitação confirmada arquivada:");
        const isReopenedRequest = entry.action === "restored" && entry.reason_note?.startsWith("Solicitação arquivada reaberta:");
        const retryAction = entry.target_ref && entry.outcome !== "completed" && expectedDetail[entry.action] === entry.detail_code
          ? isArchivedRequest ? "archive_request" : isReopenedRequest ? "reopen_request" : retryActions[entry.action]
          : undefined;
        const accountForRetry = entry.target_ref ? {
          id: entry.target_ref,
          email: entry.target_email,
          full_name: entry.target_name,
          username: null,
          role: "user",
          stored_status: "active",
          request_status: null,
          requested_at: entry.created_at,
          invite_id: null,
          invite_state: "none",
          status: "active",
          created_at: entry.created_at,
          email_confirmed_at: null,
          last_sign_in_at: null,
        } satisfies Account : null;
        return <article key={entry.id} className="rounded-2xl border border-[var(--border)] p-4"><div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between"><div className="min-w-0"><b className="text-sm">{auditActionLabel(entry)}</b><p className="muted mt-1 text-xs">{entry.target_name || entry.target_email || "Registro administrativo"} · {dateLabel(entry.created_at)}</p>{entry.reason_code && <p className="muted mt-2 text-xs">Motivo: {reasonLabels[entry.reason_code] || entry.reason_code}{entry.reason_note ? " — " + entry.reason_note : ""}</p>}{entry.actor_name && <small className="muted mt-2 block text-[11px]">Realizada por {entry.actor_name}</small>}</div><span className={"inline-flex w-fit items-center gap-1.5 rounded-full bg-[var(--panel2)] px-2.5 py-1 text-[10px] " + (entry.outcome === "completed" ? "text-[var(--accent)]" : "text-[var(--danger)]")}>{entry.outcome === "completed" ? <Check size={12}/> : <Clock3 size={12} />}{outcomeLabels[entry.outcome] || entry.outcome}</span></div>{entry.detail_code && <div className="mt-2 flex flex-wrap items-center gap-3"><small className="muted text-[11px]">A etapa no serviço de acesso não foi concluída.</small>{retryAction && accountForRetry && <button type="button" disabled={Boolean(busy)} onClick={(event) => chooseAction(accountForRetry, retryAction, event.currentTarget)} className="min-h-10 rounded-xl bg-[var(--panel2)] px-3 text-xs font-semibold text-[var(--accent)] disabled:opacity-50">Tentar novamente</button>}</div>}</article>;
      })}{!loading && audit.length === 0 && <div className="rounded-2xl bg-[var(--panel2)]/50 p-8 text-center"><Clipboard className="muted mx-auto" size={22}/><p className="mt-3 text-sm">Nenhum evento nesta consulta</p><p className="muted mt-1 text-xs">As ações feitas daqui aparecerão neste histórico.</p></div>}</div>
      {pageControls}
    </div>}

    {loading && <p role="status" className="muted mt-4 text-center text-xs">Atualizando painel…</p>}

    {pendingAction && <div className="fixed inset-0 z-[100] grid place-items-end bg-black/55 p-0 backdrop-blur-sm sm:place-items-center sm:p-5" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) closeActionDialog(); }}>
      <section ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="master-action-title" aria-describedby={pendingAction.action === "delete_permanently" ? "master-delete-warning" : pendingAction.action === "archive_request" ? "master-archive-warning" : pendingAction.action === "reopen_request" ? "master-reopen-warning" : undefined} className="panel w-full max-w-md rounded-t-3xl p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] sm:rounded-3xl sm:p-6">
        <div className="flex items-start justify-between gap-4"><div><h2 id="master-action-title" className="text-lg font-semibold">{pendingAction.action === "approve" ? "Aprovar acesso" : pendingAction.action === "reject" ? "Recusar solicitação" : pendingAction.action === "disable" ? "Desativar conta" : pendingAction.action === "trash" ? "Mover para a lixeira" : pendingAction.action === "archive_request" ? "Arquivar solicitação" : pendingAction.action === "reopen_request" ? "Reabrir solicitação" : pendingAction.action === "restore" ? "Restaurar conta" : "Excluir definitivamente?"}</h2><p className="muted mt-2 text-sm">{accountName(pendingAction.user)} · {pendingAction.user.email}</p></div><button type="button" aria-label="Fechar" disabled={Boolean(busy)} onClick={closeActionDialog} className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[var(--panel2)] disabled:opacity-50"><X size={18}/></button></div>
        {pendingAction.action === "approve" && <p className="muted mt-4 rounded-xl bg-[var(--panel2)] p-3 text-xs leading-5">O e-mail foi confirmado. Ao aprovar, o acesso financeiro desta conta será liberado. A decisão ficará registrada na auditoria.</p>}
        {pendingAction.action === "archive_request" && <p id="master-archive-warning" className="muted mt-4 rounded-xl bg-[var(--panel2)] p-3 text-xs leading-5">O pedido sairá da fila e irá para a lixeira, sem ser aprovado nem recusado. Você poderá reabri-lo depois.</p>}
        {pendingAction.action === "reopen_request" && <p id="master-reopen-warning" className="muted mt-4 rounded-xl bg-[var(--panel2)] p-3 text-xs leading-5">O pedido voltará à fila como aguardando análise. Reabrir não aprova nem libera a conta.</p>}
        {pendingAction.action === "delete_permanently" && <><p id="master-delete-warning" className="mt-4 rounded-xl border border-[var(--danger)]/25 bg-[var(--danger)]/5 p-3 text-xs leading-5 text-[var(--danger)]">A conta já está na lixeira. Esta ação remove a conta de autenticação e seus dados vinculados; não pode ser desfeita.</p><label className="mt-4 block text-xs font-medium" htmlFor="master-delete-password">Confirme sua senha Master</label><input id="master-delete-password" type="password" autoComplete="current-password" value={deletePassword} onChange={(event) => setDeletePassword(event.target.value)} className="field mt-2 min-h-11 w-full" />{deletePassword && <small className="muted mt-1 block text-xs">A senha é verificada pelo servidor e não fica salva no navegador.</small>}<label className="mt-4 block text-xs font-medium" htmlFor="master-delete-confirmation">Digite EXCLUIR para confirmar</label><input id="master-delete-confirmation" autoComplete="off" value={deleteConfirmation} onChange={(event) => setDeleteConfirmation(event.target.value)} className="field mt-2 min-h-11 w-full" />{deleteConfirmation && deleteConfirmation !== "EXCLUIR" && <small className="mt-1 block text-xs text-[var(--danger)]">Digite exatamente EXCLUIR.</small>}</>}
        {pendingAction.action !== "approve" && <><label className="mt-4 block text-xs font-medium" htmlFor="master-action-reason">Motivo para auditoria</label><select id="master-action-reason" value={reasonCode} onChange={(event) => setReasonCode(event.target.value)} className="field mt-2 min-h-11 w-full"><option value="duplicate_request">Solicitação duplicada</option><option value="incomplete_request">Informações incompletas</option><option value="policy_violation">Violação de política</option><option value="security_concern">Preocupação de segurança</option><option value="user_requested">Pedido do usuário</option><option value="other">Outro motivo</option></select></>}
        <label className="mt-4 block text-xs font-medium" htmlFor="master-action-note">Observação (opcional)</label><textarea id="master-action-note" value={reasonNote} onChange={(event) => setReasonNote(event.target.value)} maxLength={pendingAction.action === "archive_request" || pendingAction.action === "reopen_request" ? 220 : 280} rows={3} className="field mt-2 min-h-24 w-full resize-y py-3" placeholder="Até 280 caracteres" />
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><button type="button" disabled={Boolean(busy)} onClick={closeActionDialog} className="min-h-11 rounded-xl bg-[var(--panel2)] px-4 text-sm">Cancelar</button><button type="button" disabled={Boolean(busy) || (pendingAction.action === "delete_permanently" && (deleteConfirmation !== "EXCLUIR" || deletePassword.length === 0))} onClick={() => void executeAction(pendingAction, { code: reasonCode, note: reasonNote.trim() }, deletePassword)} className={"min-h-11 rounded-xl px-4 text-sm font-semibold disabled:opacity-50 " + (pendingAction.action === "delete_permanently" || pendingAction.action === "reject" ? "bg-[var(--danger)] text-white" : "bg-[var(--accent)] text-[var(--accentfg)]")}>{busy ? "Processando…" : pendingAction.action === "delete_permanently" ? "Excluir definitivamente" : pendingAction.action === "reject" ? "Recusar solicitação" : pendingAction.action === "approve" ? "Aprovar acesso" : pendingAction.action === "archive_request" ? "Arquivar solicitação" : pendingAction.action === "reopen_request" ? "Reabrir solicitação" : pendingAction.action === "trash" ? "Mover para lixeira" : "Confirmar"}</button></div>
      </section>
    </div>}
  </section>;
}
