"use client";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Image from "next/image";
import { AnimatePresence, LayoutGroup, motion, MotionConfig } from "framer-motion";
import {
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  BarChart3,
  Bell,
  Bot,
  Building2,
  CalendarDays,
  ChartNoAxesCombined,
  Check,
  ChevronLeft,
  ChevronRight,
  CirclePlus,
  CreditCard,
  Eye,
  EyeOff,
  Home,
  CircleHelp,
  Landmark,
  LockKeyhole,
  LogOut,
  Menu,
  PiggyBank,
  Pencil,
  Plus,
  ReceiptText,
  Search,
  SendHorizontal,
  ShieldCheck,
  SlidersHorizontal,
  Target,
  Tags,
  Trash2,
  WalletCards,
  X,
} from "lucide-react";
import { addMonths, format, isSameMonth, startOfMonth } from "date-fns";
import { ptBR } from "date-fns/locale";
import {
  calculateSummary,
  accountBalance,
  createInstallmentTransactions,
  formatBRL,
  monthlyContributionNeeded,
  moneyAvailability,
  projectMonthEnd,
  reconcileLinkedBalances,
  splitInstallmentCents,
  type FinanceTransaction,
} from "@/lib/finance";
import {
  isRecurringBillPaidInMonth,
  isRecurringBillScheduledInMonth,
  recurringBillDueDay,
  setRecurringBillPaidInMonth,
} from "@/lib/recurring-bills";
import { bestPurchaseDay } from "@/lib/cards";
import {
  AnimatedCard,
  AnimatedNumber,
  AnimatedPage,
  AnimatedProgress,
  StaggerContainer,
  StaggerItem,
} from "@/components/motion";
import { motionTokens } from "@/lib/motion";
import { LoginAmbient } from "@/components/login-ambient";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { loadValuriseState, saveValuriseState } from "@/lib/state-sync";
import { useSharedGoalInvites, type SharedGoalInvite, type SharedGoalSummary } from "@/hooks/use-shared-goal-invites";
import { normalizeUsername } from "@/lib/auth/username";
import { createValuriseBackup, parseValuriseBackup } from "@/lib/backup";
import { GEMINI_SUPPORTED_MODELS, getInitialAIModelOptions, isSupportedGeminiModel } from "@/lib/personal-ai/model-options";
import { AI_PROVIDER_METADATA, AI_PROVIDERS, type AIModelOption, type AIProvider } from "@/lib/personal-ai/provider-config";
import { formatValResponse } from "@/lib/personal-ai/presentation";
import { ValuriseSplash, type ValuriseSplashStatus } from "@/components/valurise-splash";
import { isValidCnpj } from "@/lib/workspaces/cnpj";
import type { WorkspaceSummary } from "@/lib/workspaces/types";
import { BusinessFinanceDashboard, BusinessFinanceSettings } from "@/components/business-finance";
type Kind = "expense" | "income" | "salary" | "investment" | "transfer";
type View =
  | "dashboard"
  | "statement"
  | "accounts"
  | "cards"
  | "investments"
  | "budgets"
  | "goals"
  | "categories"
  | "planning"
  | "reports"
  | "settings";
type AccountStatus = "pending" | "active" | "disabled" | "trashed";
type User = { username: string; name: string; status?: AccountStatus; role?: "user" | "master" };
type ProfilePreference = { photo?: string; publicId: string };
type AppNotification = {
  id: string;
  title: string;
  text: string;
  tone: "warning" | "danger" | "success";
  view: View;
};
type Institution = {
  id: string;
  name: string;
  color: string;
  accounts: { id: string; name: string; balance: number }[];
  cards: {
    id: string;
    name: string;
    limit: number;
    closingDay?: string;
    dueDay?: string;
    bestPurchaseDay?: string;
  }[];
};
type Data = {
  categories: string[];
  institutions: Institution[];
  investments?: {
    id: string;
    name: string;
    institution?: string;
    assetClass?: string;
    expectedAnnualRate?: number;
    contributedCents: number;
    currentCents?: number;
  }[];
  budgets?: {
    id: string;
    category: string;
    limitCents: number;
    month: string;
  }[];
  goals?: {
    id: string;
    name: string;
    targetCents: number;
    currentCents: number;
    targetDate?: string;
    accountId?: string;
    sharedGoalId?: string;
  }[];
  tags?: string[];
  recurringBills?: {
    id: string;
    name: string;
    amountCents: number;
    dueDay: number;
    category?: string;
    account?: string;
    frequency: "once" | "monthly" | "yearly";
    active: boolean;
    startMonth?: string;
    paidMonth?: string;
    paidMonths?: string[];
  }[];
  activity?: { id: string; text: string; date: string }[];
  monthlyReview?: Record<string, string[]>;
  dashboardWidgets?: { id: string; visible: boolean }[];
  onboarded: boolean;
};
const defaults = [
  "Alimentação",
  "Mercado",
  "Gasolina",
  "Transporte",
  "Moradia",
  "Saúde",
  "Lazer",
];
const choices = [
  ["expense", "Gastei", ArrowUpRight],
  ["expense", "Paguei", ReceiptText],
  ["income", "Recebi", ArrowDownLeft],
  ["salary", "Salário", Landmark],
  ["investment", "Investi", BarChart3],
  ["transfer", "Transferi", WalletCards],
] as const;
export default function Page() {
  const [user, setUser] = useState<User | null>(null);
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [splashStatus, setSplashStatus] = useState<ValuriseSplashStatus>("opening");
  const [splashVisible, setSplashVisible] = useState(true);
  const updateSplashStatus = useCallback((status: ValuriseSplashStatus) => {
    setSplashStatus(status);
    if (status === "syncing") setSplashVisible(true);
  }, []);
  const completeLogin = useCallback((nextUser: User) => {
    setSplashStatus(nextUser.role === "user" && nextUser.status === "active" ? "syncing" : "ready");
    setSplashVisible(true);
    setUser(nextUser);
  }, []);
  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) {
      setSplashStatus("ready");
      setCheckingAuth(false);
      return;
    }
    void supabase.auth.getUser().then(async ({ data }) => {
      if (!data.user) {
        setSplashStatus("ready");
        return;
      }
      const { data: profile } = await supabase
        .from("profiles")
        .select("full_name, account_status, account_role")
        .eq("id", data.user.id)
        .maybeSingle();
      const authenticatedUser: User = {
        username: data.user.id,
        name: profile?.full_name || String(data.user.user_metadata?.full_name || "").trim() || data.user.email?.split("@")[0] || "Você",
        status: (profile?.account_status as AccountStatus | undefined) || "pending",
        role: profile?.account_role === "master" ? "master" : "user",
      };
      setSplashStatus(authenticatedUser.role === "user" && authenticatedUser.status === "active" ? "syncing" : "ready");
      setUser(authenticatedUser);
    }).catch(() => {
      // Uma falha ao restaurar a sessão deve liberar o login em vez de prender o splash.
      setSplashStatus("ready");
    }).finally(() => setCheckingAuth(false));
  }, []);
  const logout = () => {
    void getSupabaseBrowserClient()?.auth.signOut();
    setUser(null);
  };
  let content: ReactNode = null;
  if (!checkingAuth) {
    if (user?.role === "master") content = <MasterConsole user={user} logout={logout} />;
    else if (user && user.status && user.status !== "active") content = <AccountWaiting user={user} logout={logout} />;
    else if (user) content = <WorkspaceGate user={user} logout={logout} onLoadingStatusChange={updateSplashStatus} />;
    else content = <Login done={completeLogin} />;
  }
  return (
    <>
      <div aria-hidden={splashVisible} inert={splashVisible ? true : undefined} className="min-h-dvh">
        {content}
      </div>
      {splashVisible && <ValuriseSplash status={splashStatus} onComplete={() => setSplashVisible(false)} />}
    </>
  );
}
function WorkspaceGate({ user, logout, onLoadingStatusChange }: { user: User; logout: () => void; onLoadingStatusChange: (status: ValuriseSplashStatus) => void }) {
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState("");
  const [loading, setLoading] = useState(true);
  const [switching, setSwitching] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [tradeName, setTradeName] = useState("");
  const [legalName, setLegalName] = useState("");
  const [cnpj, setCnpj] = useState("");
  const [formError, setFormError] = useState("");
  const [creating, setCreating] = useState(false);
  const beforeSwitchRef = useRef<() => Promise<void>>(async () => {});
  const registerBeforeSwitch = useCallback((flush: () => Promise<void>) => {
    beforeSwitchRef.current = flush;
  }, []);

  const loadWorkspaces = useCallback(async () => {
    const supabase = getSupabaseBrowserClient();
    const { data } = await supabase?.auth.getSession() || {};
    const token = data?.session?.access_token;
    if (!token) throw new Error("Sua sessão expirou. Entre novamente para carregar seus espaços.");
    const response = await fetch("/api/workspaces", { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Não foi possível carregar seus espaços.");
    if (!Array.isArray(result.workspaces) || !result.activeWorkspaceId) throw new Error("Nenhum espaço financeiro está disponível para esta conta.");
    return { workspaces: result.workspaces as WorkspaceSummary[], activeWorkspaceId: String(result.activeWorkspaceId) };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void loadWorkspaces().then((result) => {
      if (cancelled) return;
      setWorkspaces(result.workspaces);
      setActiveWorkspaceId(result.activeWorkspaceId);
      setLoadError("");
      setLoading(false);
    }).catch((error) => {
      if (cancelled) return;
      setLoadError(error instanceof Error ? error.message : "Não foi possível carregar seus espaços.");
      setLoading(false);
      onLoadingStatusChange("error");
    });
    return () => { cancelled = true; };
  }, [loadWorkspaces, onLoadingStatusChange]);

  const switchWorkspace = async (workspaceId: string) => {
    if (!workspaceId || workspaceId === activeWorkspaceId || switching) return;
    const flushPreviousWorkspaceWrites = beforeSwitchRef.current;
    const supabase = getSupabaseBrowserClient();
    const { data } = await supabase?.auth.getSession() || {};
    const token = data?.session?.access_token;
    if (!token) return setLoadError("Sua sessão expirou. Entre novamente para trocar de espaço.");
    setSwitching(true);
    setLoadError("");
    onLoadingStatusChange("syncing");
    try {
      await flushPreviousWorkspaceWrites();
      const response = await fetch("/api/workspaces/active", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ workspaceId }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Não foi possível trocar o espaço ativo.");
      setActiveWorkspaceId(result.activeWorkspaceId);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Não foi possível trocar o espaço ativo.");
      onLoadingStatusChange("ready");
    } finally {
      setSwitching(false);
    }
  };

  const createBusiness = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError("");
    if (!tradeName.trim() || !legalName.trim() || !isValidCnpj(cnpj)) {
      setFormError("Informe o nome fantasia, a razão social e um CNPJ válido.");
      return;
    }
    const supabase = getSupabaseBrowserClient();
    const { data } = await supabase?.auth.getSession() || {};
    const token = data?.session?.access_token;
    if (!token) return setFormError("Sua sessão expirou. Entre novamente para criar uma empresa.");
    setCreating(true);
    onLoadingStatusChange("syncing");
    try {
      await beforeSwitchRef.current();
      const response = await fetch("/api/workspaces/business", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ tradeName: tradeName.trim(), legalName: legalName.trim(), cnpj }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Não foi possível criar o espaço empresarial.");
      const created = result.workspace as WorkspaceSummary;
      setWorkspaces((current) => [...current.filter((item) => item.id !== created.id), created]);
      setActiveWorkspaceId(created.id);
      setTradeName(""); setLegalName(""); setCnpj(""); setCreateOpen(false);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Não foi possível criar o espaço empresarial.");
      onLoadingStatusChange("ready");
    } finally { setCreating(false); }
  };

  const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId) || null;
  if (loading || switching) return null;
  if (loadError && !activeWorkspace) return <main className="grid min-h-dvh place-items-center bg-[var(--bg)] px-5"><section className="panel w-full max-w-md rounded-2xl p-6 text-center"><div className="mx-auto grid h-11 w-11 place-items-center rounded-xl bg-[var(--accent)]/10 text-[var(--accent)]"><Building2 size={20}/></div><h1 className="mt-4 text-lg font-semibold">Não foi possível abrir seus espaços</h1><p role="alert" className="muted mt-2 text-sm leading-6">{loadError}</p><div className="mt-5 flex justify-center gap-2"><button onClick={() => { setLoading(true); setLoadError(""); void loadWorkspaces().then((result) => { setWorkspaces(result.workspaces); setActiveWorkspaceId(result.activeWorkspaceId); setLoading(false); }).catch((error) => { setLoadError(error instanceof Error ? error.message : "Não foi possível carregar seus espaços."); setLoading(false); }); }} className="primary min-h-10 rounded-xl px-4 text-sm">Tentar novamente</button><button onClick={logout} className="min-h-10 rounded-xl bg-[var(--panel2)] px-4 text-sm">Sair</button></div></section></main>;
  if (!activeWorkspace) return <main className="grid min-h-dvh place-items-center bg-[var(--bg)] px-5"><section className="panel w-full max-w-md rounded-2xl p-6 text-center"><h1 className="text-lg font-semibold">Nenhum espaço disponível</h1><p className="muted mt-2 text-sm">Recarregue a página ou entre em contato com o suporte.</p><button onClick={logout} className="mt-5 min-h-10 rounded-xl bg-[var(--panel2)] px-4 text-sm">Sair</button></section></main>;

  return <>
    <App key={`${user.username}:${activeWorkspace.id}`} user={user} workspace={activeWorkspace} workspaces={workspaces} onSwitchWorkspace={switchWorkspace} onRegisterBeforeWorkspaceSwitch={registerBeforeSwitch} onCreateWorkspace={() => { setFormError(""); setCreateOpen(true); }} logout={logout} onLoadingStatusChange={onLoadingStatusChange} />
    {loadError && <div role="status" className="fixed left-1/2 top-20 z-[70] w-[min(92vw,32rem)] -translate-x-1/2 rounded-xl border border-[var(--danger)]/30 bg-[var(--panel)] px-4 py-3 text-sm shadow-xl">{loadError}</div>}
    {createOpen && <div className="fixed inset-0 z-[90] grid place-items-end bg-black/55 p-0 backdrop-blur-sm sm:place-items-center sm:p-5" onMouseDown={(event) => { if (event.target === event.currentTarget && !creating) setCreateOpen(false); }}><section role="dialog" aria-modal="true" aria-labelledby="business-workspace-title" className="panel w-full max-w-lg rounded-t-3xl p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] sm:rounded-3xl sm:p-6"><div className="flex items-start justify-between gap-4"><div><h2 id="business-workspace-title" className="text-lg font-semibold">Criar espaço empresarial</h2><p className="muted mt-1 text-sm">Os dados da empresa começam vazios e separados do seu espaço pessoal.</p></div><button type="button" aria-label="Fechar" disabled={creating} onClick={() => setCreateOpen(false)} className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[var(--panel2)]"><X size={18}/></button></div><form onSubmit={(event) => void createBusiness(event)} className="mt-5 space-y-4"><label className="block text-sm">Nome fantasia<input autoFocus value={tradeName} onChange={(event) => setTradeName(event.target.value)} maxLength={120} autoComplete="organization" className="field mt-2" required /></label><label className="block text-sm">Razão social<input value={legalName} onChange={(event) => setLegalName(event.target.value)} maxLength={180} autoComplete="organization" className="field mt-2" required /></label><label className="block text-sm">CNPJ<input inputMode="numeric" autoComplete="off" value={cnpj} onChange={(event) => setCnpj(event.target.value)} maxLength={24} className="field mt-2" placeholder="00.000.000/0000-00" required /></label>{formError && <p role="alert" className="text-sm text-[var(--danger)]">{formError}</p>}<div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end"><button type="button" disabled={creating} onClick={() => setCreateOpen(false)} className="min-h-11 rounded-xl bg-[var(--panel2)] px-4 text-sm">Cancelar</button><button type="submit" disabled={creating} className="primary min-h-11 rounded-xl px-4 text-sm font-semibold disabled:opacity-60">{creating ? "Criando espaço…" : "Criar empresa"}</button></div></form></section></div>}
  </>;
}
function BusinessWorkspaceWelcome({ displayName, openAccounts, continueToDashboard }: { displayName: string; openAccounts: () => void; continueToDashboard: () => void }) {
  return <main className="grid min-h-dvh place-items-center bg-[var(--bg)] px-4 py-8"><section className="panel w-full max-w-2xl rounded-3xl p-6 sm:p-9"><span className="grid h-12 w-12 place-items-center rounded-2xl bg-[var(--accent)]/12 text-[var(--accent)]"><Building2 size={22}/></span><p className="muted mt-6 text-xs font-semibold uppercase tracking-[0.16em]">Novo espaço empresarial</p><h1 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">{displayName}</h1><p className="muted mt-3 max-w-xl text-sm leading-6">Este espaço começa separado e vazio. Cadastre as contas da empresa para acompanhar o caixa sem misturar com suas finanças pessoais.</p><div className="mt-6 grid gap-3 sm:grid-cols-3"><div className="rounded-2xl bg-[var(--panel2)] p-4"><Landmark className="text-[var(--accent)]" size={18}/><b className="mt-3 block text-sm">Caixa e contas</b><p className="muted mt-1 text-xs leading-5">Contas bancárias da empresa.</p></div><div className="rounded-2xl bg-[var(--panel2)] p-4"><ReceiptText className="text-[var(--accent)]" size={18}/><b className="mt-3 block text-sm">Entradas e saídas</b><p className="muted mt-1 text-xs leading-5">Movimente somente neste espaço.</p></div><div className="rounded-2xl bg-[var(--panel2)] p-4"><WalletCards className="text-[var(--accent)]" size={18}/><b className="mt-3 block text-sm">Visão empresarial</b><p className="muted mt-1 text-xs leading-5">Preparado para crescer com seu negócio.</p></div></div><div className="mt-7 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><button type="button" onClick={continueToDashboard} className="min-h-11 rounded-xl bg-[var(--panel2)] px-4 text-sm">Continuar depois</button><button type="button" onClick={openAccounts} className="primary min-h-11 rounded-xl px-4 text-sm font-semibold">Cadastrar primeira conta</button></div></section></main>;
}

function Login({ done }: { done: (u: User) => void }) {
  const [mode, setMode] = useState<"login" | "signup" | "forgot" | "reset">("login");
  const [inviteToken, setInviteToken] = useState("");
  const [u, setU] = useState(""), [p, setP] = useState(""), [name, setName] = useState(""), [username, setUsername] = useState(""), [e, setE] = useState(""), [notice, setNotice] = useState(""), [requestSent, setRequestSent] = useState(false), [showPassword, setShowPassword] = useState(false);
  const [privacyAccepted, setPrivacyAccepted] = useState(false);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const supabase = getSupabaseBrowserClient();
  const suggestedUsername = normalizeUsername(username);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get("invite") || "";
    setInviteToken(token);
    if (params.has("reset-password")) setMode("reset");
    else if (token) setMode("signup");
  }, []);
  async function finishSupabaseUser(authUser: { id: string; email?: string; user_metadata?: Record<string, unknown> }) {
    if (!supabase) return;
    const { data: profile } = await supabase.from("profiles").select("full_name, account_status, account_role").eq("id", authUser.id).maybeSingle();
    done({
      username: authUser.id,
      name: profile?.full_name || String(authUser.user_metadata?.full_name || "").trim() || authUser.email?.split("@")[0] || "Você",
      status: (profile?.account_status as AccountStatus | undefined) || "pending",
      role: profile?.account_role === "master" ? "master" : "user",
    });
  }
  async function submit(x: React.FormEvent) {
    x.preventDefault();
    setE(""); setNotice("");
    if (supabase && mode === "login") {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: u.trim(), password: p }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.session)
        return setE(payload.error || "Não foi possível entrar.");
      const { error } = await supabase.auth.setSession({
        access_token: payload.session.access_token,
        refresh_token: payload.session.refresh_token,
      });
      if (error || !payload.user) return setE("Não foi possível iniciar a sessão.");
      await finishSupabaseUser(payload.user);
      return;
    }
    if (supabase && mode === "signup") {
      if (!name.trim() || !username.trim()) return setE("Informe seu nome e um usuário.");
      if (!privacyAccepted || !termsAccepted) return setE("Leia e aceite a Política de Privacidade e os Termos de Uso.");
      const response = await fetch("/api/auth/request-access", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fullName: name.trim(), username: suggestedUsername, email: u.trim(), password: p, privacyAccepted, termsAccepted, ...(inviteToken ? { inviteToken } : {}) }) });
      const payload = await response.json();
      if (!response.ok) return setE(payload.error || "Não foi possível solicitar o cadastro.");
      setRequestSent(true);
      if (inviteToken) window.history.replaceState({}, "", "/");
      return;
    }
    if (supabase && mode === "forgot") {
      const response = await fetch("/api/auth/password-reset", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: u.trim() }) });
      const payload = await response.json();
      if (!response.ok) return setE(payload.error || "Não foi possível solicitar a recuperação.");
      setNotice("Se o e-mail estiver cadastrado, enviamos um link seguro para redefinir sua senha.");
      return;
    }
    if (supabase && mode === "reset") {
      const { error } = await supabase.auth.updateUser({ password: p });
      if (error) return setE(error.message);
      setNotice("Senha atualizada. Você já pode entrar.");
      setMode("login");
      window.history.replaceState({}, "", "/");
      return;
    }
    return setE("A autenticação segura não está configurada.");
  }
  return (
    <MotionConfig reducedMotion="user">
      <main className="login-shell min-h-dvh overflow-x-hidden px-5 py-5 sm:grid sm:place-items-center sm:p-7">
        <LoginAmbient />
        <div className="login-layout relative z-10 mx-auto flex w-full max-w-md flex-col py-1 sm:py-0">
          <motion.section className="login-brand text-center" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.34, ease: motionTokens.ease.enter, delay: 0.06 }}>
            <div className="login-mark-wrap"><span className="login-mark-glow" /><Image src="/valurise-icon.webp" alt="Valurise" width={512} height={512} className="login-mark" priority /></div>
            <h1>VALURISE</h1>
            <p>{mode === "signup" ? "Seu acesso começa por aqui." : mode === "forgot" ? "Vamos recuperar seu acesso com segurança." : mode === "reset" ? "Defina uma nova chave de acesso." : "Clareza para cuidar do seu patrimônio."}</p>
          </motion.section>
          {requestSent ? <motion.section className="login-card panel text-center" initial={{ opacity: 0, y: 12, scale: 0.99 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ duration: 0.36, ease: motionTokens.ease.enter, delay: 0.1 }}><Image src="/valurise-icon.webp" alt="Valurise" width={128} height={128} className="mx-auto h-14 w-14"/><h2 className="mt-5 text-xl font-semibold">Verifique o próximo passo do seu acesso</h2><p className="muted mt-3 text-sm leading-6">Se este for um cadastro novo, sua solicitação está aguardando aprovação do Master. Se o e-mail ou usuário já estiver associado a uma conta, nenhum pedido novo foi criado: entre ou recupere sua senha. Por segurança, não informamos qual situação se aplica.</p><button type="button" onClick={() => { setRequestSent(false); setMode("login"); }} className="login-submit primary mt-6">Ir para o login <ArrowRight size={18}/></button></motion.section> : <motion.form onSubmit={submit} className="login-card panel" initial={{ opacity: 0, y: 12, scale: 0.99 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ duration: 0.36, ease: motionTokens.ease.enter, delay: 0.1 }}>
            <div className="login-card-heading"><h2>{mode === "signup" ? (inviteToken ? "Acesse pelo convite" : "Solicite seu acesso") : mode === "forgot" ? "Recuperar senha" : mode === "reset" ? "Nova senha" : "Acesse sua conta"}</h2><p>{mode === "signup" ? (inviteToken ? "Seu cadastro será vinculado ao convite e enviado para aprovação." : "Seu cadastro será enviado para aprovação.") : mode === "forgot" ? "Enviaremos um link para o seu e-mail." : mode === "reset" ? "Use uma senha forte e exclusiva." : "Entre para acompanhar sua vida financeira."}</p></div>
            <div className="login-fields">
              {mode === "signup" && <><label className="login-field-label" htmlFor="signup-name">Seu nome</label><input id="signup-name" value={name} onChange={(x) => setName(x.target.value)} className="field" placeholder="Como podemos te chamar?" autoComplete="name" /><label className="login-field-label" htmlFor="signup-username">Usuário</label><input id="signup-username" value={username} onChange={(x) => setUsername(x.target.value)} className="field" placeholder="Ex.: grazi.borges" autoComplete="username" autoCapitalize="none" autoCorrect="off" />{username.trim() && <p className="muted -mt-2 text-xs">Seu usuário de acesso será: <b className="text-[var(--fg)]">{suggestedUsername || "—"}</b></p>}</>}
              {mode !== "reset" && <><label className="login-field-label" htmlFor="login-identifier">{mode === "login" ? "Identificação" : "E-mail"}</label><input id="login-identifier" value={u} onChange={(x) => setU(x.target.value)} className="field" type={mode === "login" ? "text" : "email"} placeholder={mode === "login" ? "Seu usuário ou e-mail" : "voce@exemplo.com"} autoComplete={mode === "login" ? "username" : "email"} /></>}
              {mode !== "forgot" && <><label className="login-field-label" htmlFor="login-password">{mode === "reset" ? "Nova senha" : "Senha"}</label><div className="login-password-wrap"><LockKeyhole className="login-field-icon" size={18} aria-hidden="true" /><input id="login-password" value={p} onChange={(x) => setP(x.target.value)} className="field login-password" type={showPassword ? "text" : "password"} placeholder={mode === "reset" ? "Crie uma nova senha" : "Digite sua senha"} autoComplete={mode === "reset" ? "new-password" : "current-password"} /><button className="login-password-toggle" type="button" onClick={() => setShowPassword((value) => !value)} aria-label={showPassword ? "Ocultar senha" : "Mostrar senha"}>{showPassword ? <EyeOff size={18} /> : <Eye size={18} />}</button></div></>}
            </div>
            {mode === "signup" && <div className="consent-options"><label className="consent-option"><input type="checkbox" checked={privacyAccepted} onChange={(event) => setPrivacyAccepted(event.target.checked)} /><span>Li e aceito a <a href="/privacidade" target="_blank" rel="noreferrer">Política de Privacidade</a>.</span></label><label className="consent-option"><input type="checkbox" checked={termsAccepted} onChange={(event) => setTermsAccepted(event.target.checked)} /><span>Li e aceito os <a href="/termos" target="_blank" rel="noreferrer">Termos de Uso</a>.</span></label></div>}
            <AnimatePresence>{e && <motion.p className="login-feedback login-feedback-error" initial={{ opacity: 0, y: -2 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: motionTokens.duration.fast }}>{e}</motion.p>}</AnimatePresence>
            {notice && <p className="login-feedback login-feedback-success">{notice}</p>}
            <button className="login-submit primary" type="submit"><span>{mode === "signup" ? "Solicitar cadastro" : mode === "forgot" ? "Enviar link seguro" : mode === "reset" ? "Salvar nova senha" : "Entrar na conta"}</span><ArrowRight size={18} aria-hidden="true" /></button>
            {supabase && <div className="login-actions">{mode !== "login" && <button type="button" onClick={() => { setMode("login"); setE(""); setNotice(""); }}>Já tenho acesso</button>}{mode === "login" && <><button type="button" onClick={() => { setMode("forgot"); setE(""); }}>Esqueci minha senha</button><button type="button" onClick={() => { setMode("signup"); setE(""); setPrivacyAccepted(false); setTermsAccepted(false); }}>Criar conta</button></>}</div>}
          </motion.form>}
          <motion.footer className="login-trust" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.28, delay: 0.28 }}><ShieldCheck size={15} aria-hidden="true" /> Dados protegidos com autenticação segura</motion.footer>
        </div>
      </main>
    </MotionConfig>
  );
}
function AccountWaiting({ user, logout }: { user: User; logout: () => void }) {
  const copy = user.status === "pending" ? { title: "Esperando aprovação do Master", text: "Seu cadastro foi recebido. Você será avisado assim que seu acesso for aprovado." } : user.status === "trashed" ? { title: "Conta na lixeira", text: "Esta conta foi removida temporariamente. Fale com o Master para restaurá-la." } : { title: "Conta desativada", text: "Seu acesso está desativado. Fale com o Master se precisar de ajuda." };
  return <main className="login-shell grid min-h-dvh place-items-center overflow-hidden p-5"><LoginAmbient /><section className="login-card panel relative z-10 w-full max-w-sm rounded-3xl p-7 text-center"><Image src="/valurise-icon.webp" alt="Valurise" width={512} height={512} className="mx-auto h-16 w-16" priority /><h1 className="mt-7 text-xl font-semibold">{copy.title}</h1><p className="muted mt-3 text-sm leading-6">{copy.text}</p><button onClick={logout} className="mt-7 rounded-xl bg-[var(--panel2)] px-4 py-3 text-sm">Sair desta conta</button></section></main>;
}
function MasterConsole({ user, logout }: { user: User; logout: () => void }) {
  const [message, setMessage] = useState("");
  return (
    <MotionConfig reducedMotion="user">
      <main className="min-h-dvh bg-[var(--bg)] lg:flex">
        <aside className="hidden w-64 shrink-0 flex-col border-r border-[var(--border)] bg-[color-mix(in_srgb,var(--bg)_94%,black)] px-4 py-6 lg:fixed lg:inset-y-0 lg:flex">
          <div className="flex items-center gap-2 px-2"><Image src="/valurise-icon.webp" alt="Valurise" width={56} height={56} className="h-7 w-7 object-contain" priority /><b className="text-sm tracking-tight">VALURISE</b></div>
          <span className="mt-7 inline-flex w-fit items-center gap-1.5 rounded-full bg-[var(--panel2)] px-2.5 py-1 text-[10px] font-semibold text-[#e0c298]"><span className="h-1.5 w-1.5 rounded-full bg-[#e0c298]" />MASTER ADMIN</span>
          <p className="muted mt-7 px-2 text-[10px] font-semibold tracking-widest">GOVERNANÇA</p>
          <nav className="mt-3 space-y-1 text-sm"><span className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-[var(--muted)]"><ShieldCheck size={17}/>Painel de governança</span><span className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-[var(--muted)]"><ReceiptText size={17}/>Usuários e clientes</span><span className="flex items-center gap-3 rounded-xl bg-[var(--panel2)] px-3 py-2.5 font-medium text-[var(--accent)]"><Bell size={17}/>Solicitações e convites</span><span className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-[var(--muted)]"><Search size={17}/>Auditoria e logs</span><span className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-[var(--muted)]"><SlidersHorizontal size={17}/>Configurações globais</span></nav>
          <div className="mt-auto rounded-2xl bg-[var(--panel)] p-3"><small className="muted block text-[10px] font-semibold tracking-wider">SEGURANÇA</small><span className="mt-1 flex items-center gap-1.5 text-xs text-[var(--accent)]"><span className="h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />Acesso protegido</span></div>
        </aside>
        <div className="min-w-0 flex-1 lg:pl-64">
          <header className="sticky top-0 z-20 border-b border-[var(--border)] bg-[color-mix(in_srgb,var(--bg)_90%,transparent)] backdrop-blur-xl"><div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-4 sm:px-6"><div className="flex items-center gap-3 lg:hidden"><Image src="/valurise-icon.webp" alt="Valurise" width={72} height={72} className="h-9 w-9 object-contain" priority /><b className="text-sm tracking-tight">VALURISE</b></div><span className="hidden items-center gap-2 rounded-full bg-[var(--panel)] px-3 py-2 text-xs lg:inline-flex"><span className="h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />Painel de governança</span><div className="ml-auto flex items-center gap-3"><span aria-label="Notificações do Master" className="grid h-9 w-9 place-items-center rounded-xl bg-[var(--panel2)] text-[var(--accent)]"><Bell size={18}/></span><button onClick={logout} className="rounded-xl bg-[var(--panel2)] px-3 py-2 text-xs font-medium">Sair</button></div></div></header>
          <motion.section className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-12" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: motionTokens.duration.normal, ease: motionTokens.ease.enter }}><span className="inline-flex items-center gap-2 rounded-full bg-[var(--accent)]/10 px-3 py-1.5 text-xs font-semibold text-[var(--accent)]"><ShieldCheck size={14} /> PAINEL MASTER · ACESSO RESTRITO</span><div className="mt-5 flex flex-col justify-between gap-4 sm:flex-row sm:items-end"><div><h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Gestão de titulares<br className="hidden sm:block" /> e solicitações</h1><p className="muted mt-3 max-w-xl text-sm leading-6">Controle de acessos da Valurise. Esta área não exibe dados financeiros dos usuários.</p></div><span className="rounded-xl bg-[var(--panel2)] px-3 py-2 text-xs text-[var(--muted)]">Master: {user.name}</span></div>{message && <div role="status" className="mt-5 rounded-xl border border-[var(--accent)]/25 bg-[var(--accent)]/10 px-4 py-3 text-sm text-[var(--accent)]">{message}</div>}<section className="panel mt-7 rounded-3xl p-5 sm:p-6"><MasterUsers toast={setMessage} /></section><p className="muted mt-5 text-xs leading-5">Aprovar libera o acesso. Desativar bloqueia temporariamente. Lixeira mantém a conta recuperável; a exclusão definitiva só é possível a partir da lixeira.</p></motion.section>
        </div>
      </main>
    </MotionConfig>
  );
}
function App({ user, workspace, workspaces, onSwitchWorkspace, onRegisterBeforeWorkspaceSwitch, onCreateWorkspace, logout, onLoadingStatusChange }: { user: User; workspace: WorkspaceSummary; workspaces: WorkspaceSummary[]; onSwitchWorkspace: (workspaceId: string) => void; onRegisterBeforeWorkspaceSwitch: (flush: () => Promise<void>) => void; onCreateWorkspace: () => void; logout: () => void; onLoadingStatusChange: (status: ValuriseSplashStatus) => void }) {
  const oldPersonalKey = `valurise:v2:${user.username}`;
  const key = `${oldPersonalKey}:workspace:${workspace.id}`;
  const legacyKey = `lume:v2:${user.username}`;
  const [data, setData] = useState<Data>({
    categories: [],
    institutions: [],
    onboarded: false,
  });
  const [stateReady, setStateReady] = useState(false);
  const [stateLoadError, setStateLoadError] = useState(false);
  const [stateConflict, setStateConflict] = useState(false);
  const [tx, setTx] = useState<FinanceTransaction[]>([]);
  const [view, setView] = useState<View>("dashboard");
  const [sheet, setSheet] = useState(false);
  const [mobileMenu, setMobileMenu] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [profile, setProfile] = useState<ProfilePreference>({ publicId: "" });
  const dataRef = useRef(data);
  const txRef = useRef(tx);
  const profileRef = useRef(profile);
  const stateVersionRef = useRef<number | null>(null);
  const stateWriteQueue = useRef<Promise<void>>(Promise.resolve());
  const stateConflictRef = useRef(false);
  useEffect(() => {
    onRegisterBeforeWorkspaceSwitch(async () => {
      await stateWriteQueue.current;
      if (stateConflictRef.current) throw new Error("Resolva a sincronização pendente antes de trocar de espaço.");
    });
    return () => onRegisterBeforeWorkspaceSwitch(async () => {});
  }, [onRegisterBeforeWorkspaceSwitch]);
  const [theme, setTheme] = useState("dark");
  const [systemPrefersLight, setSystemPrefersLight] = useState(false);
  const [toast, setToast] = useState("");
  const [month, setMonth] = useState(startOfMonth(new Date()));
  const [dismissedNotificationIds, setDismissedNotificationIds] = useState<string[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      const saved = JSON.parse(localStorage.getItem(`${key}:dismissed-alerts`) || "[]");
      return Array.isArray(saved) ? saved.filter((id): id is string => typeof id === "string") : [];
    } catch {
      return [];
    }
  });
  const localSharedGoalIds = useMemo(
    () => (data.goals || []).map((goal) => goal.sharedGoalId).filter((id): id is string => Boolean(id)),
    [data.goals],
  );
  const inviteInbox = useSharedGoalInvites(workspace.type === "personal" ? user.username : "", workspace.type === "personal" ? localSharedGoalIds : [], setToast);
  useEffect(() => { dataRef.current = data; }, [data]);
  useEffect(() => { txRef.current = tx; }, [tx]);
  useEffect(() => { profileRef.current = profile; }, [profile]);
  useEffect(() => {
    onLoadingStatusChange(stateLoadError ? "error" : stateReady ? "ready" : "syncing");
  }, [onLoadingStatusChange, stateLoadError, stateReady]);
  useEffect(() => {
    let stale = false;
    setStateReady(false);
    setStateLoadError(false);
    void (async () => {
      try {
        for (const suffix of [":data", ":tx", ":theme", ":profile"]) {
          const currentValue = localStorage.getItem(key + suffix);
          const legacyPersonalValue = workspace.type === "personal" ? localStorage.getItem(oldPersonalKey + suffix) : null;
          const legacyValue = workspace.type === "personal" ? localStorage.getItem(legacyKey + suffix) : null;
          if (!currentValue && (legacyPersonalValue || legacyValue)) localStorage.setItem(key + suffix, legacyPersonalValue || legacyValue || "");
        }
        const localData = JSON.parse(
          localStorage.getItem(key + ":data") ||
            '{"categories":[],"institutions":[],"onboarded":false}',
        );
        const localTx = JSON.parse(localStorage.getItem(key + ":tx") || "[]");
        setTheme(localStorage.getItem(key + ":theme") || "dark");
        const savedProfile = localStorage.getItem(key + ":profile");
        const localProfile = savedProfile
          ? JSON.parse(savedProfile)
          : {
              publicId: `VAL-${user.username.slice(0, 4).toUpperCase()}-${crypto.randomUUID().slice(0, 4).toUpperCase()}`,
            };
        if (!savedProfile)
          localStorage.setItem(key + ":profile", JSON.stringify(localProfile));
        const remoteResult = await loadValuriseState<
          Data,
          FinanceTransaction,
          ProfilePreference
        >(workspace.id);
        const remote = remoteResult?.state || null;
        stateVersionRef.current = remoteResult?.version ?? null;
        if (stale) return;
        const supabase = getSupabaseBrowserClient();
        const { data: databaseProfile } = supabase
          ? await supabase
              .from("profiles")
              .select("public_id, avatar_path")
              .maybeSingle()
          : { data: null };
        if (stale) return;
        const state = remote || {
          data: localData,
          transactions: localTx,
          profile: localProfile,
        };
        // The shareable ID is database-owned. A local fallback only supports
        // the unconfigured development experience and is never used to invite.
        if (databaseProfile?.public_id) {
          state.profile = {
            ...state.profile,
            publicId: databaseProfile.public_id,
            ...(databaseProfile.avatar_path
              ? { photo: databaseProfile.avatar_path }
              : {}),
          };
        }
        setData(state.data);
        setTx(state.transactions);
        setProfile(state.profile);
        if (!remote) {
          const result = await saveValuriseState(state, workspace, null);
          if (result.synced) stateVersionRef.current = result.version ?? 1;
          if (result.reason === "conflict") {
            const latest = await loadValuriseState<Data, FinanceTransaction, ProfilePreference>(workspace.id);
            if (!latest) throw new Error("Outra sessão criou seus dados durante o carregamento.");
            stateVersionRef.current = latest.version;
            setData(latest.state.data); setTx(latest.state.transactions); setProfile(latest.state.profile);
            localStorage.setItem(key + ":data", JSON.stringify(latest.state.data));
            localStorage.setItem(key + ":tx", JSON.stringify(latest.state.transactions));
            localStorage.setItem(key + ":profile", JSON.stringify(latest.state.profile));
          }
          if (!result.synced && result.reason !== "not-configured" && result.reason !== "conflict") setToast("Seus dados locais abriram, mas ainda não sincronizaram. Tente novamente antes de trocar de dispositivo.");
        }
        if (!stale) setStateReady(true);
      } catch {
        if (!stale) setStateLoadError(true);
      }
    })();
    return () => {
      stale = true;
    };
  }, [key, legacyKey, oldPersonalKey, user.username, workspace]);
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const update = () => setSystemPrefersLight(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);
  const saveData = (next: Data) => {
    dataRef.current = next;
    setData(next);
    localStorage.setItem(key + ":data", JSON.stringify(next));
    persistState({ data: next, transactions: txRef.current, profile: profileRef.current });
  };
  const saveTx = (next: FinanceTransaction[]) => {
    const previousData = dataRef.current;
    const reconciledData = reconcileLinkedBalances(previousData, txRef.current, next);
    dataRef.current = reconciledData;
    if (reconciledData !== previousData) {
      setData(reconciledData);
      localStorage.setItem(key + ":data", JSON.stringify(reconciledData));
    }
    txRef.current = next;
    setTx(next);
    localStorage.setItem(key + ":tx", JSON.stringify(next));
    persistState({ data: reconciledData, transactions: next, profile: profileRef.current });
  };
  const restoreFinancialBackup = (nextData: Data, nextTransactions: FinanceTransaction[]) => {
    dataRef.current = nextData;
    txRef.current = nextTransactions;
    setData(nextData);
    setTx(nextTransactions);
    localStorage.setItem(key + ":data", JSON.stringify(nextData));
    localStorage.setItem(key + ":tx", JSON.stringify(nextTransactions));
    persistState({ data: nextData, transactions: nextTransactions, profile: profileRef.current });
  };
  const saveProfile = (next: ProfilePreference) => {
    profileRef.current = next;
    setProfile(next);
    localStorage.setItem(key + ":profile", JSON.stringify(next));
    persistState({ data: dataRef.current, transactions: txRef.current, profile: next });
    const supabase = getSupabaseBrowserClient();
    if (supabase) {
      void supabase.auth.getUser().then(({ data: auth }) => {
        if (auth.user) {
          void supabase
            .from("profiles")
            .update({ avatar_path: next.photo || null })
            .eq("id", auth.user.id);
        }
      });
    }
  };
  const persistState = (state: { data: Data; transactions: FinanceTransaction[]; profile: ProfilePreference }) => {
    const write = async () => {
      if (stateConflictRef.current) return;
      const result = await saveValuriseState(state, workspace, stateVersionRef.current);
      if (result.synced) { stateVersionRef.current = result.version ?? 1; return; }
      if (result.reason === "conflict") {
        stateConflictRef.current = true;
        setStateConflict(true);
        return;
      }
      if (result.reason !== "not-configured") setToast("Alteração salva neste dispositivo, mas não sincronizou com sua conta.");
    };
    stateWriteQueue.current = stateWriteQueue.current.catch(() => undefined).then(write).catch(() => {
      setToast("Não foi possível sincronizar esta alteração com sua conta.");
    });
  };
  const approvePersonalAiAction = async (proposalId: string) => {
    await stateWriteQueue.current.catch(() => undefined);
    if (stateConflictRef.current || stateVersionRef.current === null) {
      throw new Error("Atualize os dados sincronizados antes de confirmar uma proposta da Val.");
    }
    const supabase = getSupabaseBrowserClient();
    const { data: auth } = await supabase?.auth.getSession() || {};
    const token = auth?.session?.access_token;
    if (!token) throw new Error("Sua sessão expirou. Entre novamente para confirmar.");
    const response = await fetch("/api/personal-ai/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "X-Valurise-Workspace-Id": workspace.id },
      body: JSON.stringify({ proposalId, decision: "approve" }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Não foi possível confirmar a proposta.");

    const latest = await loadValuriseState<Data, FinanceTransaction, ProfilePreference>(workspace.id);
    if (!latest) throw new Error("A proposta foi registrada, mas não foi possível atualizar esta tela. Recarregue os dados antes de tentar novamente.");
    stateVersionRef.current = latest.version;
    dataRef.current = latest.state.data;
    txRef.current = latest.state.transactions;
    profileRef.current = latest.state.profile;
    setData(latest.state.data);
    setTx(latest.state.transactions);
    setProfile(latest.state.profile);
    localStorage.setItem(key + ":data", JSON.stringify(latest.state.data));
    localStorage.setItem(key + ":tx", JSON.stringify(latest.state.transactions));
    localStorage.setItem(key + ":profile", JSON.stringify(latest.state.profile));
    setToast("Lançamento confirmado e sincronizado.");
  };
  const recordSharedGoalContribution = (input: {
    sharedGoalId: string;
    amountCents: number;
    accountLabel: string;
    date: string;
    localGoalId?: string;
  }) => {
    if (workspace.type !== "personal") {
      setToast("O compartilhamento de metas está disponível no espaço pessoal.");
      return Promise.resolve(false);
    }
    const operation = stateWriteQueue.current.catch(() => undefined).then(async () => {
      if (stateConflictRef.current || stateVersionRef.current === null) {
        setToast("Atualize os dados sincronizados antes de contribuir com a meta.");
        return false;
      }
      const supabase = getSupabaseBrowserClient();
      if (!supabase) {
        setToast("A contribuição compartilhada precisa de uma conexão ativa.");
        return false;
      }
      const { data: response, error } = await supabase.rpc("contribute_to_shared_goal", {
        p_shared_goal_id: input.sharedGoalId,
        p_amount_cents: input.amountCents,
        p_account_label: input.accountLabel,
        p_transaction_date: dateAtLocalNoon(input.date),
        p_expected_version: stateVersionRef.current,
        p_local_goal_id: input.localGoalId || null,
      });
      if (error) {
        if (error.code === "40001") {
          stateConflictRef.current = true;
          setStateConflict(true);
          setToast("Os dados mudaram em outro dispositivo. Atualize antes de registrar a contribuição.");
        } else {
          setToast("Não foi possível registrar a contribuição compartilhada. Confira a conta e tente novamente.");
        }
        return false;
      }
      const result = response as { version?: number; transaction?: FinanceTransaction } | null;
      if (!result?.transaction || !Number.isInteger(result.version)) {
        setToast("A contribuição foi enviada, mas não recebemos a confirmação. Atualize os dados antes de tentar novamente.");
        return false;
      }

      const previousData = dataRef.current;
      const nextData = input.localGoalId
        ? {
            ...previousData,
            goals: (previousData.goals || []).map((goal) => goal.id === input.localGoalId
              ? { ...goal, currentCents: goal.currentCents + input.amountCents }
              : goal),
          }
        : previousData;
      const nextTransactions = [...txRef.current, result.transaction];
      dataRef.current = nextData;
      txRef.current = nextTransactions;
      setData(nextData);
      setTx(nextTransactions);
      localStorage.setItem(key + ":data", JSON.stringify(nextData));
      localStorage.setItem(key + ":tx", JSON.stringify(nextTransactions));
      stateVersionRef.current = result.version as number;
      await inviteInbox.refresh();
      setToast("Contribuição registrada. A meta e o extrato foram atualizados.");
      return true;
    });
    stateWriteQueue.current = operation.then(() => undefined).catch(() => undefined);
    return operation;
  };
  const createCategory = (name: string) => {
    const clean = name.trim();
    if (!clean) return;
    const exists = data.categories.some(
      (x) => x.localeCompare(clean, "pt-BR", { sensitivity: "accent" }) === 0,
    );
    if (!exists) saveData({ ...data, categories: [...data.categories, clean] });
    setToast("Categoria criada com sucesso.");
  };
  const createInvestment = (name: string, assetClass: string) => {
    const item = {
      id: crypto.randomUUID(),
      name: name.trim(),
      assetClass,
      contributedCents: 0,
    };
    if (!item.name) return null;
    saveData({
      ...data,
      investments: [...(data.investments || []), item],
    });
    setToast("Investimento criado. Agora confirme seu aporte.");
    return item;
  };
  const current = useMemo(
    () => tx.filter((x) => isSameMonth(new Date(x.date), month)),
    [tx, month],
  );
  const sum = useMemo(() => calculateSummary(current), [current]);
  const total = useMemo(() => calculateSummary(tx), [tx]);
  const notifications = useMemo(
    () => getFinancialNotifications(data, tx),
    [data, tx],
  ).filter((item) => !dismissedNotificationIds.includes(item.id));
  const dismissNotification = (id: string) => {
    const next = [...new Set([...dismissedNotificationIds, id])];
    setDismissedNotificationIds(next);
    localStorage.setItem(`${key}:dismissed-alerts`, JSON.stringify(next));
  };
  const dismissAllNotifications = () => {
    const next = [...new Set([...dismissedNotificationIds, ...notifications.map((item) => item.id)])];
    setDismissedNotificationIds(next);
    localStorage.setItem(`${key}:dismissed-alerts`, JSON.stringify(next));
  };
  if (!stateReady) {
    if (!stateLoadError) return null;
    return <main className="grid min-h-dvh place-items-center bg-[var(--bg)] px-5 text-center"><section className="panel w-full max-w-md rounded-2xl p-6"><b className="text-base">Não foi possível confirmar seus dados</b><p className="muted mt-2 text-sm leading-6">Por segurança, a Valurise não vai substituir os dados salvos. Verifique sua conexão e tente novamente.</p><button onClick={() => window.location.reload()} className="primary mt-4 min-h-11 rounded-xl px-4 text-sm font-semibold">Tentar novamente</button></section></main>;
  }
  if (!data.onboarded)
    return workspace.type === "personal" ? (
      <Onboard
        user={user}
        finish={(n) => saveData({ ...n, onboarded: true })}
      />
    ) : <BusinessWorkspaceWelcome displayName={workspace.displayName} openAccounts={() => { saveData({ ...data, onboarded: true }); setView("accounts"); }} continueToDashboard={() => saveData({ ...data, onboarded: true })} />;
  const setT = (next: string) => {
    setTheme(next);
    localStorage.setItem(key + ":theme", next);
  };
  const useLightTheme =
    theme === "light" || (theme === "system" && systemPrefersLight);
  return (
    <MotionConfig reducedMotion="user">
    <main className={useLightTheme ? "light min-h-dvh overflow-x-clip" : "min-h-dvh overflow-x-clip"}>
      <aside className="panel fixed inset-y-0 hidden w-60 border-y-0 border-l-0 p-5 lg:block">
        <Brand />
        <LayoutGroup id="desktop-navigation">
        <nav className="mt-10 space-y-1">
          {nav.map((n) => (
            <Nav
              key={n[0]}
              n={n}
              active={view === n[0]}
              go={() => setView(n[0])}
            />
          ))}
        </nav>
        </LayoutGroup>
        <button
          onClick={logout}
          className="muted absolute bottom-6 flex gap-2 text-sm"
        >
          <LogOut size={16} />
          Sair
        </button>
      </aside>
      <AnimatePresence>
      {mobileMenu && (
        <motion.div
          className="fixed inset-0 z-50 lg:hidden"
          role="dialog"
          aria-modal="true"
          aria-label="Menu principal"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: motionTokens.duration.normal }}
        >
          <button
            aria-label="Fechar menu"
            onClick={() => setMobileMenu(false)}
            className="absolute inset-0 bg-black/45 backdrop-blur-sm"
          />
          <motion.aside
            className="panel absolute right-3 top-3 max-h-[calc(100dvh-1.5rem)] w-[min(82vw,320px)] overflow-y-auto overscroll-contain rounded-3xl p-4 shadow-2xl"
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 12 }}
            transition={{ duration: 0.3, ease: motionTokens.ease.enter }}
          >
            <div className="flex items-center justify-between">
              <Brand />
              <button
                aria-label="Fechar menu"
                onClick={() => setMobileMenu(false)}
                className="rounded-xl bg-[var(--panel2)] p-2"
              >
                <X size={18} />
              </button>
            </div>
            <button
              onClick={() => {
                setMobileMenu(false);
                setSearchOpen(true);
              }}
              className="muted mt-4 flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-sm hover:bg-[var(--panel2)]"
            >
              <Search size={18} />
              <span>Buscar em todo o Valurise</span>
            </button>
            <p className="muted mt-6 px-2 text-[11px] tracking-widest">
              NAVEGAÇÃO
            </p>
            <nav className="mt-3 space-y-1">
              {nav.map((n) => (
                <button
                  key={n[0]}
                  onClick={() => {
                    setView(n[0]);
                    setMobileMenu(false);
                  }}
                  className={`flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-sm ${view === n[0] ? "bg-[var(--panel2)] text-[var(--accent)]" : "muted"}`}
                >
                  {(() => {
                    const Icon = n[2];
                    return <Icon size={18} />;
                  })()}
                  <span>{n[1]}</span>
                </button>
              ))}
            </nav>
            <button
              onClick={logout}
              className="muted mt-5 flex w-full items-center gap-3 rounded-xl px-3 py-3 text-sm hover:bg-[var(--panel2)]"
            >
              <LogOut size={16} />
              Sair
            </button>
          </motion.aside>
        </motion.div>
      )}
      </AnimatePresence>
      <section className="min-w-0 pb-[calc(11rem+env(safe-area-inset-bottom))] lg:ml-60 lg:pb-40">
        <header className="sticky top-0 z-30 flex h-16 items-center justify-between gap-0 border-b border-[var(--border)] bg-[var(--bg)]/95 px-3 backdrop-blur-xl sm:gap-2 sm:px-4 lg:px-10">
          <div className="shrink-0 lg:hidden">
            <Brand compactOnMobile className="shrink-0" />
          </div>
          <div className="flex min-w-0 items-center gap-1">
            <label className="sr-only" htmlFor="active-workspace">Espaço financeiro ativo</label>
            <select id="active-workspace" aria-label="Espaço financeiro ativo" title={`${workspace.type === "personal" ? "Pessoal" : "Empresa"} · ${workspace.displayName}`} value={workspace.id} onChange={(event) => onSwitchWorkspace(event.target.value)} className="field workspace-selector h-10 min-h-10 min-w-0 px-2 text-xs font-medium sm:px-3">
              {workspaces.map((item) => <option key={item.id} value={item.id}>{item.type === "personal" ? "Pessoal" : "Empresa"} · {item.displayName}</option>)}
            </select>
            <button type="button" onClick={onCreateWorkspace} aria-label="Criar espaço empresarial" title="Criar espaço empresarial" className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-[var(--panel2)] text-[var(--accent)]"><Plus size={18}/></button>
          </div>
          <div className="flex shrink-0 items-center gap-0.5 sm:gap-2">
            <button
              aria-label="Buscar em todo o Valurise"
              onClick={() => setSearchOpen(true)}
              className="header-search-trigger grid h-11 w-11 place-items-center rounded-xl bg-[var(--panel2)]"
            >
              <Search size={18} />
            </button>
            <button
              aria-label={`Abrir notificações${notifications.length + inviteInbox.invites.length ? ` (${notifications.length + inviteInbox.invites.length})` : ""}`}
              onClick={() => setNotificationsOpen((open) => !open)}
              className="relative grid h-11 w-11 place-items-center rounded-xl bg-[var(--panel2)]"
            >
              <Bell size={18} />
              {notifications.length + inviteInbox.invites.length > 0 && (
                <span className="absolute -right-1 -top-1 grid h-4 min-w-4 place-items-center rounded-full bg-[var(--accent)] px-1 text-[9px] font-bold text-[var(--accentfg)]">
                  {notifications.length + inviteInbox.invites.length > 9 ? "9+" : notifications.length + inviteInbox.invites.length}
                </span>
              )}
            </button>
            <button
              aria-label="Abrir perfil"
              onClick={() => setProfileOpen(true)}
              className="grid h-11 w-11 overflow-hidden place-items-center rounded-full bg-[var(--panel2)] text-xs font-medium"
            >
              {profile.photo ? (
                <Image
                  unoptimized
                  src={profile.photo}
                  alt="Foto de perfil"
                  width={72}
                  height={72}
                  className="h-full w-full object-cover"
                />
              ) : (
                user.name[0]
              )}
            </button>
            <button
              aria-label="Abrir menu"
              onClick={() => setMobileMenu(true)}
              className="grid h-11 w-11 place-items-center rounded-xl bg-[var(--panel2)] lg:hidden"
            >
              <Menu size={18} />
            </button>
          </div>
        </header>
        {stateConflict && <section role="alert" className="mx-4 mt-4 rounded-2xl border border-amber-400/30 bg-amber-400/10 p-4 lg:mx-10"><b className="text-sm">Seus dados foram alterados em outro dispositivo</b><p className="muted mt-1 text-xs leading-5">A sincronização foi pausada para evitar sobrescrever uma versão. Exporte a cópia local ou recarregue para continuar com a versão mais recente da conta.</p><div className="mt-3 flex flex-wrap gap-2"><button onClick={() => { const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), data: dataRef.current, transactions: txRef.current, profile: profileRef.current }, null, 2)], { type: "application/json" }); const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = `valurise-copia-local-${format(new Date(), "yyyy-MM-dd")}.json`; link.click(); URL.revokeObjectURL(url); }} className="min-h-11 rounded-xl bg-[var(--panel2)] px-3 text-xs">Exportar cópia local</button><button onClick={() => window.location.reload()} className="min-h-11 rounded-xl bg-[var(--panel2)] px-3 text-xs">Recarregar versão sincronizada</button></div></section>}
        {profileOpen && (
          <ProfileSheet
            user={user}
            profile={profile}
            save={saveProfile}
            theme={theme}
            setTheme={setT}
            reset={() => {
              localStorage.removeItem(key + ":data");
              localStorage.removeItem(key + ":tx");
              setData({ categories: [], institutions: [], onboarded: false });
              setTx([]);
              setProfileOpen(false);
              setToast("Informações do app foram resetadas.");
            }}
            close={() => setProfileOpen(false)}
            toast={setToast}
          />
        )}
        {notificationsOpen && (
          <NotificationCenter
            items={notifications}
            invites={inviteInbox.invites}
            loadError={inviteInbox.loadError}
            realtimeAvailable={inviteInbox.realtimeAvailable}
            respondingId={inviteInbox.respondingId}
            refreshInvites={inviteInbox.refresh}
            respondInvite={inviteInbox.respond}
            dismiss={dismissNotification}
            dismissAll={dismissAllNotifications}
            close={() => setNotificationsOpen(false)}
            go={(next) => {
              setView(next);
              setNotificationsOpen(false);
            }}
          />
        )}
        {searchOpen && (
          <GlobalSearch
            data={data}
            tx={tx}
            close={() => setSearchOpen(false)}
            go={(next) => {
              setView(next);
              setSearchOpen(false);
            }}
          />
        )}
        <AnimatePresence mode="wait">
        <AnimatedPage key={view}>
        {view === "dashboard" && (
          <Dashboard
            user={user}
            workspace={workspace}
            workspaceId={workspace.id}
            sum={sum}
            total={total}
            tx={current}
            allTx={tx}
            data={data}
            save={saveData}
            month={month}
            setMonth={setMonth}
            go={setView}
            sharedGoals={inviteInbox.sharedGoals}
          />
        )}{" "}
        {view === "statement" && (
          <Statement tx={tx} month={month} save={saveTx} toast={setToast} />
        )}{" "}
        {view === "accounts" && (
          <Institutions data={data} save={saveData} toast={setToast} />
        )}{" "}
        {view === "cards" && (
          <Cards data={data} save={saveData} toast={setToast} />
        )}{" "}
        {view === "investments" && (
          <Investments data={data} transactions={tx} save={saveData} saveTransactions={saveTx} toast={setToast} />
        )}
        {view === "budgets" && (
          <Budgets data={data} tx={tx} month={month} save={saveData} toast={setToast} />
        )}
        {view === "goals" && (
          <Goals data={data} transactions={tx} save={saveData} saveTransactions={saveTx} toast={setToast} invites={inviteInbox.invites} respondInvite={inviteInbox.respond} sharedGoals={inviteInbox.sharedGoals} recordSharedGoalContribution={recordSharedGoalContribution} userId={user.username} allowSharing={workspace.type === "personal"} />
        )}
        {view === "categories" && (
          <Categories data={data} tx={tx} month={month} save={saveData} saveTx={saveTx} toast={setToast} />
        )}{" "}
        {view === "planning" && (
          <Planning data={data} tx={tx} month={month} save={saveData} toast={setToast} />
        )}
        {view === "reports" && <Reports tx={tx} data={data} month={month} />}
        {view === "settings" && (
          <Settings
            theme={theme}
            setTheme={setT}
            data={data}
            tx={tx}
            saveData={saveData}
            saveTx={saveTx}
            restoreFinancialBackup={restoreFinancialBackup}
            toast={setToast}
            logout={logout}
            localStoragePrefix={key}
            workspaceId={workspace.id}
            businessWorkspace={workspace.type === "business"}
          />
        )}
        </AnimatedPage>
        </AnimatePresence>
        <button
          aria-label="Registrar movimentação"
          onClick={() => setSheet(true)}
          className={
            view === "dashboard"
              ? "panel fixed bottom-[max(18px,env(safe-area-inset-bottom))] right-4 z-20 flex h-14 w-14 items-center justify-center rounded-2xl p-2 text-left shadow-2xl md:right-6 md:h-auto md:w-auto md:max-w-xs md:justify-start md:gap-3 md:p-3 lg:right-10"
              : "primary fixed bottom-[max(22px,env(safe-area-inset-bottom))] right-5 z-20 grid h-14 w-14 place-items-center rounded-full shadow-2xl lg:right-10"
          }
        >
          {view === "dashboard" ? (
            <>
              <span className="primary grid h-10 w-10 place-items-center rounded-xl">
                <FinanceChatIcon />
              </span>
              <span className="hidden md:block">
                <b className="block text-sm">Registrar movimentação</b>
                <small className="muted">
                  O que aconteceu com seu dinheiro?
                </small>
              </span>
            </>
          ) : (
            <FinanceChatIcon />
          )}
        </button>
        {sheet && (
          <Launcher
            data={data}
            workspace={workspace}
            createCategory={createCategory}
            createInvestment={createInvestment}
            close={() => setSheet(false)}
            approvePersonalAiAction={approvePersonalAiAction}
            saved={(n) => {
              saveTx([...n, ...tx]);
              setToast("Lançamento salvo com sucesso.");
              setSheet(false);
            }}
          />
        )}
        <AnimatePresence>
        {toast && (
          <motion.div
            role="status"
            className="fixed right-4 top-4 z-50 rounded-xl bg-[var(--accent)] px-4 py-3 text-sm font-medium text-[var(--accentfg)]"
            initial={{ opacity: 0, x: 15 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 10 }}
            transition={{ duration: motionTokens.duration.normal, ease: motionTokens.ease.enter }}
          >
            {toast}
          </motion.div>
        )}
        </AnimatePresence>
      </section>
    </main>
    </MotionConfig>
  );
}
const nav: any = [
  ["dashboard", "Dashboard", Home],
  ["statement", "Extrato", ReceiptText],
  ["accounts", "Contas", Landmark],
  ["cards", "Cartões", CreditCard],
  ["investments", "Investimentos", BarChart3],
  ["budgets", "Orçamentos", PiggyBank],
  ["goals", "Metas", Target],
  ["planning", "Planejamento", CalendarDays],
  ["reports", "Relatórios", ChartNoAxesCombined],
  ["categories", "Categorias", Tags],
  ["settings", "Ajustes", Menu],
];
function getFinancialNotifications(data: Data, tx: FinanceTransaction[]): AppNotification[] {
  const today = new Date();
  const day = today.getDate();
  const month = format(today, "yyyy-MM");
  const items: AppNotification[] = [];

  (data.recurringBills || []).forEach((bill) => {
    if (!isRecurringBillScheduledInMonth(bill, month) || isRecurringBillPaidInMonth(bill, month)) return;
    const dueDay = recurringBillDueDay(bill, month);
    if (dueDay < day) {
      items.push({
        id: `late-${bill.id}-${month}`,
        title: `${bill.name} está atrasada`,
        text: `Venceu no dia ${dueDay}. Marque como paga ou confira o lançamento.`,
        tone: "danger",
        view: "planning",
      });
    } else if (dueDay - day <= 3) {
      items.push({
        id: `due-${bill.id}-${month}`,
        title: `${bill.name} vence em ${dueDay - day} dia(s)`,
        text: `${formatBRL(bill.amountCents)} · vencimento dia ${dueDay}.`,
        tone: "warning",
        view: "planning",
      });
    }
  });

  (data.budgets || []).forEach((budget) => {
    if (budget.month !== month || budget.limitCents <= 0) return;
    const spent = tx
      .filter(
        (item) =>
          item.type === "expense" &&
          item.category === budget.category &&
          item.date.startsWith(month),
      )
      .reduce((total, item) => total + item.amountCents, 0);
    const percent = Math.round((spent / budget.limitCents) * 100);
    if (percent >= 100) {
      items.push({
        id: `budget-over-${budget.id}-${month}`,
        title: `${budget.category} ultrapassou o orçamento`,
        text: `Você usou ${formatBRL(spent)} de ${formatBRL(budget.limitCents)}.`,
        tone: "danger",
        view: "budgets",
      });
    } else if (percent >= 80) {
      items.push({
        id: `budget-${budget.id}-${month}`,
        title: `${budget.category} chegou a ${percent}%`,
        text: `Restam ${formatBRL(budget.limitCents - spent)} neste orçamento.`,
        tone: "warning",
        view: "budgets",
      });
    }
  });

  (data.goals || []).forEach((goal) => {
    if (!goal.targetDate || goal.currentCents >= goal.targetCents) return;
    const monthly = monthlyContributionNeeded(
      goal.targetCents,
      goal.currentCents,
      goal.targetDate,
      today,
    );
    items.push({
      id: `goal-${goal.id}-${month}`,
      title: `${goal.name}: próximo passo`,
      text: `Reserve ${formatBRL(monthly)}/mês para chegar até o prazo.`,
      tone: "success",
      view: "goals",
    });
  });
  return items.slice(0, 8);
}
function NotificationCenter({
  items,
  invites,
  loadError,
  realtimeAvailable,
  respondingId,
  refreshInvites,
  respondInvite,
  dismiss,
  dismissAll,
  close,
  go,
}: {
  items: AppNotification[];
  invites: SharedGoalInvite[];
  loadError: boolean;
  realtimeAvailable: boolean | null;
  respondingId: string | null;
  refreshInvites: () => Promise<void>;
  respondInvite: (inviteId: string, accept: boolean) => Promise<boolean>;
  dismiss: (id: string) => void;
  dismissAll: () => void;
  close: () => void;
  go: (view: View) => void;
}) {
  return (
    <motion.section
      aria-label="Notificações financeiras"
      className="panel fixed left-4 right-4 top-[4.5rem] z-40 mx-auto max-h-[min(34rem,calc(100dvh-6rem))] w-auto max-w-md overflow-y-auto rounded-2xl p-3 shadow-2xl sm:left-auto sm:right-6"
      initial={{ opacity: 0, y: -4, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: motionTokens.duration.fast, ease: motionTokens.ease.enter }}
    >
      <div className="flex items-center justify-between gap-3 px-2 py-2">
        <div>
          <b>Notificações</b>
          <p className="muted mt-0.5 text-xs">Convites e alertas da sua vida financeira</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button onClick={() => void refreshInvites()} className="rounded-lg px-2 py-2 text-xs text-[var(--accent)] hover:bg-[var(--panel2)]">Atualizar</button>
          <button aria-label="Fechar notificações" onClick={close} className="rounded-lg p-2 hover:bg-[var(--panel2)]">
            <X size={17} />
          </button>
        </div>
      </div>
      {realtimeAvailable === false && <p className="mx-2 mt-2 rounded-xl bg-amber-400/10 px-3 py-2 text-xs leading-5 text-amber-300">Conexão instantânea indisponível. Vamos conferir novos convites automaticamente; você também pode tocar em Atualizar.</p>}
      {loadError && <p role="alert" className="mx-2 mt-2 rounded-xl bg-[var(--danger)]/10 px-3 py-2 text-xs leading-5 text-[var(--danger)]">Não foi possível consultar os convites agora. Tente atualizar em instantes.</p>}
      {invites.length > 0 && (
        <section className="mt-3">
          <div className="flex items-center justify-between px-2">
            <b className="text-xs uppercase tracking-wide text-[var(--accent)]">Convites de metas</b>
            <span className="rounded-full bg-[var(--accent)]/15 px-2 py-0.5 text-[10px] font-semibold text-[var(--accent)]">{invites.length}</span>
          </div>
          <div className="mt-2 space-y-2">
            {invites.map((invite) => {
              const goal = invite.shared_goals;
              return <article key={invite.id} className="rounded-xl border border-[var(--accent)]/20 bg-[var(--accent)]/5 p-3">
                <b className="block truncate text-sm">{goal?.name || "Meta compartilhada"}</b>
                <p className="muted mt-1 text-xs leading-5">Alguém convidou você para acompanhar esta meta. Seus outros dados financeiros continuam privados.</p>
                {goal?.target_cents ? <small className="muted mt-1 block">Objetivo: {formatBRL(goal.target_cents)}</small> : null}
                <div className="mt-3 flex gap-2">
                  <button disabled={respondingId !== null} onClick={() => void respondInvite(invite.id, false)} className="min-h-10 flex-1 rounded-lg bg-[var(--panel2)] px-3 text-xs font-medium disabled:opacity-50">{respondingId === invite.id ? "Aguarde…" : "Recusar"}</button>
                  <button disabled={respondingId !== null} onClick={() => void respondInvite(invite.id, true)} className="primary min-h-10 flex-1 rounded-lg px-3 text-xs font-semibold disabled:opacity-50">{respondingId === invite.id ? "Aguarde…" : "Aceitar convite"}</button>
                </div>
              </article>;
            })}
          </div>
        </section>
      )}
      {items.length ? (
        <section className="mt-3">
          <div className="flex items-center justify-between px-2">
            <b className="text-xs uppercase tracking-wide muted">Alertas</b>
            <button onClick={dismissAll} className="rounded-lg px-2 py-1 text-xs text-[var(--accent)] hover:bg-[var(--panel2)]">Dispensar todos</button>
          </div>
          <div className="mt-1 divide-y divide-[var(--border)]">
            {items.map((item) => (
              <div key={item.id} className="flex items-start gap-1 px-1 py-1">
                <button
                  onClick={() => {
                    dismiss(item.id);
                    go(item.view);
                  }}
                  className="flex min-w-0 flex-1 items-start gap-3 rounded-xl px-2 py-3 text-left hover:bg-[var(--panel2)]"
                >
                  <span
                    className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${item.tone === "danger" ? "bg-[var(--danger)]" : item.tone === "warning" ? "bg-amber-400" : "bg-[var(--accent)]"}`}
                  />
                  <span className="min-w-0">
                    <b className="block text-sm">{item.title}</b>
                    <small className="muted mt-1 block leading-4">{item.text}</small>
                  </span>
                </button>
                <button aria-label={`Dispensar ${item.title}`} onClick={() => dismiss(item.id)} className="mt-2 grid h-9 w-9 shrink-0 place-items-center rounded-lg muted hover:bg-[var(--panel2)] hover:text-[var(--fg)]"><X size={15} /></button>
              </div>
            ))}
          </div>
        </section>
      ) : null}
      {!invites.length && !items.length && !loadError && (
        <div className="px-2 py-7 text-center">
          <span className="mx-auto grid h-10 w-10 place-items-center rounded-xl bg-[var(--accent)]/15 text-[var(--accent)]">
            <Bell size={18} />
          </span>
          <b className="mt-3 block text-sm">Tudo em dia</b>
          <p className="muted mt-1 text-xs">Novos alertas aparecerão aqui.</p>
        </div>
      )}
    </motion.section>
  );
}
function FinanceChatIcon() {
  return (
    <svg
      className="block h-6 w-6 shrink-0"
      viewBox="0 0 28 28"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M14 3.5c-5.55 0-9.5 3.54-9.5 8.24 0 2.02.8 3.82 2.2 5.2L5.2 22l5.05-1.48c1.13.5 2.4.76 3.75.76 5.55 0 9.5-3.54 9.5-8.24S19.55 3.5 14 3.5Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <path
        d="m9 14.05 3.2-3.1 2.5 2.35 4.35-4.2"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="19.05" cy="9.1" r="1.05" fill="currentColor" />
    </svg>
  );
}
function GlobalSearch({ data, tx, close, go }: any) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLocaleLowerCase("pt-BR");
  const transactions = needle
    ? tx
        .filter((item: FinanceTransaction) =>
          `${item.description || ""} ${item.category} ${item.account} ${(item.tags || []).join(" ")}`
            .toLocaleLowerCase("pt-BR")
            .includes(needle),
        )
        .slice(0, 5)
    : [];
  const destinations = [
    ...(data.categories || []).map((name: string) => ({ label: name, detail: "Categoria", view: "categories" as View })),
    ...(data.institutions || []).map((item: Institution) => ({ label: item.name, detail: "Instituição", view: "accounts" as View })),
    ...(data.investments || []).map((item: any) => ({ label: item.name, detail: "Investimento", view: "investments" as View })),
    ...(data.goals || []).map((item: any) => ({ label: item.name, detail: "Meta", view: "goals" as View })),
  ].filter((item) => needle && item.label.toLocaleLowerCase("pt-BR").includes(needle)).slice(0, 6);
  return (
    <Sheet close={close}>
      <section>
        <div className="flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-xl bg-[var(--accent)]/15 text-[var(--accent)]"><Search size={18} /></span>
          <div><b className="block text-lg">Busca global</b><p className="muted mt-1 text-xs">Lançamentos, categorias, contas, metas e investimentos.</p></div>
        </div>
        <input autoFocus className="field mt-5" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Ex.: gasolina, reserva, Nubank" />
        {needle ? (
          <div className="mt-4 space-y-5">
            {transactions.length > 0 && <div><p className="muted text-[11px] font-semibold tracking-widest">LANÇAMENTOS</p><div className="mt-2 divide-y divide-[var(--border)] rounded-2xl bg-[var(--panel2)] px-3">{transactions.map((item: FinanceTransaction) => <button key={item.id} onClick={() => go("statement")} className="flex w-full items-center justify-between gap-3 py-3 text-left"><span className="min-w-0"><b className="block truncate text-sm">{item.description || item.category}</b><small className="muted block truncate">{item.category} · {item.account}</small></span><b className="shrink-0 text-sm">{formatBRL(item.amountCents)}</b></button>)}</div></div>}
            {destinations.length > 0 && <div><p className="muted text-[11px] font-semibold tracking-widest">SEÇÕES</p><div className="mt-2 divide-y divide-[var(--border)] rounded-2xl bg-[var(--panel2)] px-3">{destinations.map((item) => <button key={`${item.view}-${item.label}`} onClick={() => go(item.view)} className="flex w-full items-center justify-between gap-3 py-3 text-left"><span><b className="block text-sm">{item.label}</b><small className="muted">{item.detail}</small></span><ChevronRight className="text-[var(--accent)]" size={16} /></button>)}</div></div>}
            {!transactions.length && !destinations.length && <Empty text="Nenhum resultado encontrado." />}
          </div>
        ) : <Empty text="Comece digitando para pesquisar em todo o seu financeiro." />}
      </section>
    </Sheet>
  );
}
function Brand({ className = "", compactOnMobile = false }: { className?: string; compactOnMobile?: boolean }) {
  return (
    <span className={`inline-flex items-center gap-2 font-semibold tracking-[-0.04em] ${className}`}>
      <Image src="/valurise-icon.webp" alt="Logo Valurise" width={1254} height={1254} className="h-7 w-7 rounded-lg" priority />
      <span className={`${compactOnMobile ? "hidden md:inline" : ""} text-lg`}>VALURISE</span>
    </span>
  );
}
function Nav({ n, active, go }: any) {
  const I = n[2];
  return (
    <motion.button
      onClick={go}
      whileTap={{ scale: 0.97 }}
      className={`relative flex min-w-14 flex-col items-center gap-1 overflow-hidden rounded-xl px-2 py-2 text-[10px] lg:w-full lg:flex-row lg:gap-3 lg:px-3 lg:text-sm ${active ? "text-[var(--accent)]" : "muted"}`}
    >
      {active && (
        <motion.span
          layoutId="active-navigation-indicator"
          className="absolute inset-0 rounded-xl bg-[var(--panel2)]"
          transition={{ duration: motionTokens.duration.fast, ease: motionTokens.ease.standard }}
        />
      )}
      <I className="relative" size={18} />
      <span className="relative">{n[1]}</span>
    </motion.button>
  );
}
function Theme({ value, change }: any) {
  return (
    <div className="flex rounded-full bg-[var(--panel2)] p-1 text-[10px]">
      {["light", "dark", "system"].map((x) => (
        <button
          onClick={() => change(x)}
          className={`rounded-full px-2 py-1 ${value === x ? "bg-[var(--panel)]" : ""}`}
          key={x}
        >
          {x === "light" ? "Claro" : x === "dark" ? "Escuro" : "Sistema"}
        </button>
      ))}
    </div>
  );
}
async function compressProfilePhoto(file: File) {
  const image = await createImageBitmap(file);
  const max = 320;
  const scale = Math.min(1, max / Math.max(image.width, image.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.width * scale));
  canvas.height = Math.max(1, Math.round(image.height * scale));
  canvas.getContext("2d")?.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/webp", 0.82);
}
function ProfileSheet({
  user,
  profile,
  save,
  theme,
  setTheme,
  reset,
  close,
  toast,
}: any) {
  const [confirmReset, setConfirmReset] = useState(false);
  return (
    <Sheet close={close}>
      <section className="space-y-5">
        <div className="flex items-center gap-3">
          <label className="relative grid h-16 w-16 shrink-0 cursor-pointer place-items-center overflow-hidden rounded-full bg-[var(--panel2)] text-lg font-semibold">
            <input
              className="hidden"
              type="file"
              accept="image/*"
              onChange={async (event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                try {
                  save({ ...profile, photo: await compressProfilePhoto(file) });
                  toast("Foto atualizada e otimizada em WebP.");
                } catch {
                  toast("Não foi possível processar a imagem.");
                }
              }}
            />
            {profile.photo ? (
              <Image
                unoptimized
                src={profile.photo}
                alt="Foto de perfil"
                width={128}
                height={128}
                className="h-full w-full object-cover"
              />
            ) : (
              user.name[0]
            )}
          </label>
          <div>
            <b className="block text-lg">{user.name}</b>
            <p className="muted text-sm">@{user.username}</p>
            <label className="mt-1 inline-block cursor-pointer text-xs text-[var(--accent)]">
              Alterar foto
              <input
                className="hidden"
                type="file"
                accept="image/*"
                onChange={async (event) => {
                  const file = event.target.files?.[0];
                  if (!file) return;
                  try {
                    save({
                      ...profile,
                      photo: await compressProfilePhoto(file),
                    });
                    toast("Foto atualizada e otimizada em WebP.");
                  } catch {
                    toast("Não foi possível processar a imagem.");
                  }
                }}
              />
            </label>
          </div>
        </div>
        <section className="rounded-2xl bg-[var(--panel2)] p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="muted text-xs">SEU ID VALURISE</p>
              <b className="mt-1 block tracking-wide">{profile.publicId}</b>
            </div>
            <button
              onClick={async () => {
                await navigator.clipboard?.writeText(profile.publicId);
                toast("ID Valurise copiado.");
              }}
              className="rounded-xl bg-[var(--panel)] px-3 py-2 text-xs"
            >
              Copiar
            </button>
          </div>
          <p className="muted mt-2 text-xs">
            Use este ID para receber convites de metas compartilhadas quando o
            Supabase estiver conectado.
          </p>
        </section>
        <section>
          <div className="flex items-center justify-between">
            <div>
              <b className="text-sm">Aparência</b>
              <p className="muted mt-1 text-xs">Escolha como a Valurise aparece.</p>
            </div>
          </div>
          <div className="mt-3">
            <Theme value={theme} change={setTheme} />
          </div>
        </section>
        <section className="border-t border-[var(--border)] pt-4">
          <b className="text-sm">Segurança e dados</b>
          <button
            onClick={async () => {
              const supabase = getSupabaseBrowserClient();
              if (!supabase) return toast("A autenticação segura ainda não está disponível.");
              const { data } = await supabase.auth.getUser();
              if (!data.user?.email) return toast("A autenticação segura ainda não está disponível.");
              const { error } = await supabase.auth.resetPasswordForEmail(data.user.email, { redirectTo: `${window.location.origin}/?reset-password=1` });
              toast(error ? "Não foi possível enviar o link de senha." : "Enviamos um link seguro para seu e-mail.");
            }}
            className="mt-3 flex w-full items-center justify-between rounded-xl bg-[var(--panel2)] px-4 py-3 text-left text-sm"
          >
            <span>Alterar senha</span>
            <span className="muted text-xs">Enviar link</span>
          </button>
          {user.role === "master" && <MasterUsers toast={toast} />}
          {confirmReset ? (
            <div className="mt-3 rounded-xl border border-[var(--danger)]/40 p-3">
              <p className="text-sm">
                Isso apaga lançamentos e configurações deste dispositivo.
              </p>
              <div className="mt-3 flex gap-2">
                <button
                  className="rounded-lg bg-[var(--panel2)] px-3 py-2 text-sm"
                  onClick={() => setConfirmReset(false)}
                >
                  Cancelar
                </button>
                <button
                  className="rounded-lg px-3 py-2 text-sm text-[var(--danger)]"
                  onClick={reset}
                >
                  Resetar tudo
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setConfirmReset(true)}
              className="mt-2 flex w-full items-center justify-between rounded-xl px-4 py-3 text-left text-sm text-[var(--danger)] hover:bg-[var(--panel2)]"
            >
              <span>Resetar informações do app</span>
              <span>→</span>
            </button>
          )}
        </section>
        <button
          onClick={close}
          className="primary h-11 w-full rounded-xl text-sm"
        >
          Concluído
        </button>
      </section>
    </Sheet>
  );
}
type MasterUser = { id: string; email?: string; lastSignInAt?: string; createdAt: string; profile: { full_name?: string; username?: string; account_status?: AccountStatus; account_role?: string } | null };
function MasterUsers({ toast }: { toast: (text: string) => void }) {
  const [users, setUsers] = useState<MasterUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [deleteCandidate, setDeleteCandidate] = useState<string | null>(null);
  const [inviteLink, setInviteLink] = useState("");
  const load = useCallback(async () => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { data } = await supabase.auth.getSession();
    if (!data.session?.access_token) return;
    const response = await fetch("/api/admin/users", { headers: { Authorization: `Bearer ${data.session.access_token}` } });
    const body = await response.json();
    if (response.ok) setUsers(body.users || []);
    else toast(body.error || "Não foi possível carregar usuários.");
    setLoading(false);
  }, [toast]);
  useEffect(() => {
    void load();
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;

    // Postgres Changes uses a WebSocket. The subscription is deliberately
    // limited to profiles: financial tables are never exposed to the Master.
    const channel = supabase
      .channel("valurise-master-registration-requests")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "profiles" },
        (payload) => {
          const profile = payload.new as {
            account_status?: AccountStatus;
            account_role?: string;
          };
          if (profile.account_status !== "pending" || profile.account_role === "master") return;
          toast("Novo pedido de acesso recebido.");
          void load();
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [load, toast]);
  // Realtime is the immediate path. This small fallback keeps the Master queue
  // correct if a phone temporarily suspends its WebSocket in the background.
  useEffect(() => {
    const refresh = window.setInterval(() => void load(), 20_000);
    return () => window.clearInterval(refresh);
  }, [load]);
  const act = async (userId: string, action: "approve" | "disable" | "restore" | "trash" | "delete_permanently") => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { data } = await supabase.auth.getSession();
    if (!data.session?.access_token) return;
    setBusy(`${userId}:${action}`);
    const response = await fetch("/api/admin/users", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${data.session.access_token}` }, body: JSON.stringify({ userId, action }) });
    const body = await response.json();
    setBusy(null);
    if (!response.ok) return toast(body.error || "Não foi possível atualizar esta conta.");
    toast("Conta atualizada.");
    void load();
  };
  const createInvite = async () => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { data } = await supabase.auth.getSession();
    if (!data.session?.access_token) return;
    const response = await fetch("/api/admin/invites", { method: "POST", headers: { Authorization: `Bearer ${data.session.access_token}` } });
    const body = await response.json();
    if (!response.ok) return toast(body.error || "Não foi possível gerar o convite.");
    setInviteLink(body.link);
    toast("Link de convite criado por 7 dias.");
  };
  const pendingUsers = users.filter((item) => item.profile?.account_status === "pending" && item.profile?.account_role !== "master");
  const managedUsers = users.filter((item) => item.profile?.account_status !== "pending" || item.profile?.account_role === "master");
  const pendingCount = pendingUsers.length;
  const renderUser = (item: MasterUser, request = false) => {
    const status = item.profile?.account_status || "pending";
    const label = item.profile?.full_name || item.email || "Usuário";
    const working = busy?.startsWith(item.id);
    const confirmingDelete = deleteCandidate === item.id;
    const isMasterAccount = item.profile?.account_role === "master";
    return <article key={item.id} className={`rounded-2xl border p-4 ${request ? "border-[var(--accent)]/35 bg-[var(--accent)]/8" : "border-[var(--border)] bg-[var(--panel2)]/65"}`}><div className="flex items-start justify-between gap-3"><span className="min-w-0"><b className="block truncate text-sm">{label}</b><small className="muted mt-1 block truncate">{item.email}</small><small className={`mt-1 block text-[11px] capitalize ${request ? "text-[var(--accent)]" : "text-[var(--accent)]"}`}>{isMasterAccount ? "Conta Master" : status}</small></span>{status === "pending" && !isMasterAccount && <button disabled={working} onClick={() => void act(item.id, "approve")} className="shrink-0 rounded-xl bg-[var(--accent)] px-3 py-2 text-xs font-semibold text-[var(--accentfg)]">Aprovar</button>}</div>{!isMasterAccount && !request && <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-xs"><button disabled={working} onClick={() => void act(item.id, status === "trashed" ? "restore" : "trash")} className="muted hover:text-[var(--fg)]">{status === "trashed" ? "Restaurar da lixeira" : "Mover para lixeira"}</button>{status !== "trashed" && <button disabled={working} onClick={() => void act(item.id, status === "disabled" ? "restore" : "disable")} className="muted hover:text-[var(--fg)]">{status === "disabled" ? "Reativar" : "Desativar"}</button>}{status === "trashed" && (confirmingDelete ? <><button disabled={working} onClick={() => { setDeleteCandidate(null); void act(item.id, "delete_permanently"); }} className="font-medium text-[var(--danger)]">Confirmar exclusão definitiva</button><button disabled={working} onClick={() => setDeleteCandidate(null)} className="muted">Cancelar</button></> : <button disabled={working} onClick={() => setDeleteCandidate(item.id)} className="text-[var(--danger)]">Excluir definitivo</button>)}</div>}{confirmingDelete && <p className="mt-3 text-xs text-[var(--danger)]">Esta ação apaga a conta e todos os dados financeiros dela.</p>}</article>;
  };
  return <section><div className="flex items-start justify-between gap-4"><div><div className="flex items-center gap-2"><b className="text-lg">Usuários e convites</b>{pendingCount > 0 && <span className="rounded-full bg-[var(--accent)] px-2 py-0.5 text-[10px] font-bold text-[var(--accentfg)]">{pendingCount} pendente{pendingCount > 1 ? "s" : ""}</span>}</div><p className="muted mt-1 text-xs">Aprova acessos e administra contas sem ler dados financeiros.</p></div><button onClick={() => void load()} className="shrink-0 text-xs text-[var(--accent)]">Atualizar</button></div><section aria-live="polite" className="mt-5 rounded-2xl border border-[var(--accent)]/25 bg-[var(--accent)]/7 p-4"><div className="flex items-center justify-between gap-3"><span className="flex items-center gap-2"><Bell size={16} className="text-[var(--accent)]"/><b className="text-sm">Solicitações de acesso</b></span><span className="rounded-full bg-[var(--accent)] px-2.5 py-1 text-xs font-bold text-[var(--accentfg)]">{pendingCount}</span></div>{loading ? <p className="muted mt-3 text-xs">Verificando solicitações…</p> : pendingCount ? <div className="mt-3 space-y-2">{pendingUsers.map((item) => renderUser(item, true))}</div> : <p className="muted mt-3 text-xs">Nenhuma solicitação pendente no momento.</p>}</section><div className="mt-5 rounded-2xl bg-[var(--panel2)] p-4"><div className="flex items-center justify-between gap-3"><span><b className="block text-sm">Convidar novo usuário</b><small className="muted block pt-1">O cadastro pelo link continua sujeito à sua aprovação.</small></span><button onClick={() => void createInvite()} className="shrink-0 rounded-xl border border-[var(--accent)] px-3 py-2 text-xs font-semibold text-[var(--accent)]">Gerar link</button></div>{inviteLink && <div className="mt-4 flex gap-2"><input aria-label="Link de convite" readOnly value={inviteLink} className="field min-w-0 flex-1 text-xs"/><button onClick={async () => { await navigator.clipboard?.writeText(inviteLink); toast("Link copiado."); }} className="rounded-xl bg-[var(--panel)] px-3 text-xs">Copiar</button></div>}</div>{!loading && <div className="mt-5"><b className="text-sm">Contas gerenciadas</b><div className="mt-3 max-h-[28rem] space-y-2 overflow-y-auto pr-1">{managedUsers.map((item) => renderUser(item))}</div></div>}</section>;
}
function Dashboard({
  user,
  workspace,
  workspaceId,
  sum,
  total,
  tx,
  allTx,
  data,
  save,
  month,
  setMonth,
  go,
  sharedGoals = [],
}: any) {
  const [customizingDashboard, setCustomizingDashboard] = useState(false);
  const [greeting, setGreeting] = useState("Olá");
  useEffect(() => {
    const hour = new Date().getHours();
    setGreeting(hour < 12 ? "Bom dia" : hour < 18 ? "Boa tarde" : "Boa noite");
  }, []);
  const accountBalanceCents = (data.institutions || []).reduce(
    (institutionTotal: number, institution: Institution) =>
      institutionTotal +
      institution.accounts.reduce(
        (accountTotal: number, account) =>
          accountTotal +
          accountBalance(
            account.balance,
            `${institution.name} • ${account.name}`,
            allTx,
          ),
        0,
      ),
    0,
  );
  const availability = moneyAvailability(
    accountBalanceCents,
    data.recurringBills || [],
    month,
  );
  return (
    <StaggerContainer className="mx-auto max-w-5xl px-4 pt-5 lg:px-10">
      <StaggerItem>
      <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
        {greeting}, {user.name}.
      </h1>
      </StaggerItem>
      <StaggerItem>
      <div className="mt-5 flex justify-between">
        <button onClick={() => setMonth(addMonths(month, -1))}>
          <ChevronLeft />
        </button>
        <b className="capitalize">
          {format(month, "MMMM yyyy", { locale: ptBR })}
        </b>
        <button onClick={() => setMonth(addMonths(month, 1))}>
          <ChevronRight />
        </button>
      </div>
      </StaggerItem>
      {workspace?.type === "business" && <BusinessFinanceDashboard workspaceId={workspaceId} month={month} data={data} allTransactions={allTx} go={go} />}
      <StaggerItem>
      <AnimatedCard className="panel mt-5 rounded-3xl p-6">
        <p className="muted text-sm">Patrimônio total</p>
        <p className="mt-2 text-4xl font-semibold">
          <AnimatedNumber cents={total.balanceCents} />
        </p>
        <div className="mt-7 grid grid-cols-2 gap-x-5 gap-y-4 border-t border-[var(--border)] pt-4 sm:grid-cols-4 sm:gap-3">
          <K l="Entrou" v={sum.incomeCents} />
          <K l="Consumo" v={sum.expenseCents} />
          <K l="Aportes" v={sum.investmentCents} />
          <K l="Resultado" v={sum.incomeCents - sum.expenseCents} />
        </div>
        <div className="mt-5 grid gap-3 border-t border-[var(--border)] pt-4 sm:grid-cols-3">
          <FinancialMetric label="Saldo disponível" value={accountBalanceCents} />
          <FinancialMetric label="Compromissos do mês" value={availability.committedCents} negative />
          <FinancialMetric label="Disponível para gastar" value={availability.freeToSpendCents} accent help="Saldo disponível menos contas recorrentes ainda pendentes neste mês." />
        </div>
      </AnimatedCard>
      </StaggerItem>
      <DashboardWidgets
        data={data}
        tx={tx}
        allTx={allTx}
        sum={sum}
        go={go}
        save={save}
        customizing={customizingDashboard}
        setCustomizing={setCustomizingDashboard}
        sharedGoals={sharedGoals}
      />
      <StaggerItem>
      <div className="mt-5 flex justify-center">
        <button
          onClick={() => setCustomizingDashboard(true)}
          className="flex items-center gap-2 rounded-xl bg-[var(--panel2)] px-4 py-3 text-sm font-medium hover:ring-1 hover:ring-[var(--accent)]"
        >
          <SlidersHorizontal size={16} />
          Organizar cards do Dashboard
        </button>
      </div>
      </StaggerItem>
    </StaggerContainer>
  );
}
function FinancialMetric({ label, value, negative, accent, help }: { label: string; value: number; negative?: boolean; accent?: boolean; help?: string }) {
  return (
    <div className="min-w-0 rounded-2xl bg-[var(--panel2)] px-4 py-3" title={help}>
      <p className="muted text-[11px]">{label}{help ? " · ⓘ" : ""}</p>
      <b className={`mt-1 block truncate text-sm ${negative ? "text-[var(--danger)]" : accent ? "text-[var(--accent)]" : ""}`}>
        {negative ? "−" : ""}{formatBRL(Math.abs(value))}
      </b>
    </div>
  );
}
const dashboardWidgetDefaults = [
  { id: "flow", label: "Receitas x despesas" },
  { id: "categories", label: "Gastos por categoria" },
  { id: "evolution", label: "Evolução financeira" },
  { id: "improvements", label: "Melhorias para você" },
  { id: "budget", label: "Orçamentos" },
  { id: "goal", label: "Metas" },
  { id: "investment", label: "Investimentos" },
  { id: "calendar", label: "Calendário financeiro" },
  { id: "accounts", label: "Contas e cartões" },
  { id: "statement", label: "Extrato recente" },
];
function DashboardWidgets({
  data,
  tx,
  allTx,
  sum,
  go,
  save,
  customizing,
  setCustomizing,
  sharedGoals = [],
}: any) {
  const savedWidgets = data.dashboardWidgets || [];
  const widgets = [
    ...savedWidgets.filter((widget: any) =>
      dashboardWidgetDefaults.some((item) => item.id === widget.id),
    ),
    ...dashboardWidgetDefaults
      .filter(
        (item) => !savedWidgets.some((widget: any) => widget.id === item.id),
      )
      .map((item) => ({ id: item.id, visible: true })),
  ];
  const update = (next: { id: string; visible: boolean }[]) =>
    save({ ...data, dashboardWidgets: next });
  const move = (index: number, direction: number) => {
    const next = [...widgets];
    const target = index + direction;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    update(next);
  };
  const render = (id: string) =>
    id === "flow" ? (
      <CashflowPreview key={id} sum={sum} />
    ) : id === "categories" ? (
      <CategorySpendPreview key={id} sum={sum} />
    ) : id === "evolution" ? (
      <FinancialEvolution key={id} allTx={allTx} />
    ) : id === "improvements" ? (
      <ImprovementsPanel key={id} data={data} tx={tx} sum={sum} />
    ) : id === "budget" ? (
      <BudgetPreview key={id} data={data} tx={tx} go={go} />
    ) : id === "goal" ? (
      <GoalPreview key={id} data={data} go={go} sharedGoals={sharedGoals} />
    ) : id === "investment" ? (
      <InvestmentPreview key={id} data={data} go={go} />
    ) : id === "calendar" ? (
      <CalendarDashboardPreview key={id} data={data} go={go} />
    ) : id === "accounts" ? (
      <AccountsDashboardPreview key={id} data={data} allTx={allTx} go={go} />
    ) : (
      <RecentStatementPreview key={id} tx={tx} go={go} />
    );
  return (
    <section className="mt-4">
      <StaggerContainer className="grid gap-4 md:grid-cols-2">
        {widgets
          .filter((widget) => widget.visible)
          .map((widget) => (
            <StaggerItem key={widget.id} layout>
              {render(widget.id)}
            </StaggerItem>
          ))}
      </StaggerContainer>
      {!widgets.some((widget) => widget.visible) && (
        <section className="panel rounded-2xl p-5">
          <Empty text="Nenhum card de acompanhamento selecionado." />
          <button
            onClick={() => setCustomizing(true)}
            className="mt-3 text-sm text-[var(--accent)]"
          >
            Escolher cards
          </button>
        </section>
      )}
      {customizing && (
        <Sheet close={() => setCustomizing(false)}>
          <section>
            <div className="flex items-start gap-3">
              <span className="grid h-10 w-10 place-items-center rounded-xl bg-[var(--accent)]/15 text-[var(--accent)]">
                <SlidersHorizontal size={18} />
              </span>
              <div>
                <b className="block text-lg">Organizar cards</b>
                <p className="muted mt-1 text-sm">
                  Patrimônio disponível é fixo. Escolha os demais cards e a
                  ordem em que aparecem.
                </p>
              </div>
            </div>
            <div className="mt-5 flex items-center justify-between">
              <b className="text-sm">Ordem dos cards</b>
              <button
                onClick={() =>
                  update(
                    dashboardWidgetDefaults.map((item) => ({
                      id: item.id,
                      visible: true,
                    })),
                  )
                }
                className="text-xs text-[var(--accent)]"
              >
                Restaurar padrão
              </button>
            </div>
            <div className="mt-2 max-h-[min(48dvh,26rem)] space-y-2 overflow-y-auto overscroll-contain pr-1">
              {widgets.map((widget, index) => {
                const info = dashboardWidgetDefaults.find(
                  (item) => item.id === widget.id,
                )!;
                return (
                  <div
                    key={widget.id}
                    className="flex items-center gap-2 rounded-xl bg-[var(--panel2)] p-3"
                  >
                    <button
                      aria-label={`Alternar ${info.label}`}
                      onClick={() =>
                        update(
                          widgets.map((item) =>
                            item.id === widget.id
                              ? { ...item, visible: !item.visible }
                              : item,
                          ),
                        )
                      }
                      className={`grid h-8 w-8 place-items-center rounded-lg ${widget.visible ? "bg-[var(--accent)] text-[var(--accentfg)]" : "bg-[var(--panel)] muted"}`}
                    >
                      {widget.visible ? <Check size={16} /> : <X size={16} />}
                    </button>
                    <span className="muted text-xs">{index + 1}</span>
                    <b className="min-w-0 flex-1 text-sm">{info.label}</b>
                    <button
                      disabled={index === 0}
                      onClick={() => move(index, -1)}
                      className="rounded-lg px-2 py-1 text-sm disabled:opacity-30"
                    >
                      ↑
                    </button>
                    <button
                      disabled={index === widgets.length - 1}
                      onClick={() => move(index, 1)}
                      className="rounded-lg px-2 py-1 text-sm disabled:opacity-30"
                    >
                      ↓
                    </button>
                  </div>
                );
              })}
            </div>
            <button
              onClick={() => setCustomizing(false)}
              className="primary mt-5 h-11 w-full rounded-xl text-sm"
            >
              Concluído
            </button>
          </section>
        </Sheet>
      )}
    </section>
  );
}
function CashflowPreview({ sum }: { sum: ReturnType<typeof calculateSummary> }) {
  const bars = [
    { label: "Receitas", amount: sum.incomeCents, tone: "bg-[var(--accent)]" },
    { label: "Consumo", amount: sum.expenseCents, tone: "bg-[var(--danger)]" },
  ];
  const max = Math.max(sum.incomeCents, sum.expenseCents, 1);
  return (
    <section className="panel rounded-2xl p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <b>Receitas x despesas</b>
          <p className="muted mt-1 text-xs">Fluxo do mês selecionado</p>
        </div>
        <span
          title={formatBRL(sum.incomeCents - sum.expenseCents)}
          className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${sum.incomeCents - sum.expenseCents >= 0 ? "bg-[var(--accent)]/15 text-[var(--accent)]" : "bg-[var(--danger)]/15 text-[var(--danger)]"}`}
        >
          {sum.incomeCents - sum.expenseCents >= 0 ? "+" : ""}
          {formatCompactBRL(sum.incomeCents - sum.expenseCents)}
        </span>
      </div>
      {sum.incomeCents || sum.expenseCents ? (
        <>
          <div className="mt-5 grid grid-cols-2 gap-3">
            {bars.map((bar) => (
              <div className="rounded-xl bg-[var(--panel2)] p-3" key={bar.label}>
                <span className="muted block text-[11px]">{bar.label}</span>
                <b title={formatBRL(bar.amount)} className="mt-1 block text-sm">
                  {formatCompactBRL(bar.amount)}
                </b>
              </div>
            ))}
          </div>
          <div className="relative mt-4 flex h-28 items-end gap-5 overflow-hidden rounded-2xl bg-[var(--panel2)] px-7 pb-5 pt-3">
            <span className="absolute inset-x-5 top-[33%] border-t border-[var(--border)]" />
            <span className="absolute inset-x-5 top-[66%] border-t border-[var(--border)]" />
            {bars.map((bar) => (
              <div className="relative z-10 flex h-full flex-1 flex-col justify-end" key={bar.label}>
                <motion.span
                  className={`${bar.tone} min-h-1 rounded-t-xl shadow-[0_-5px_18px_rgba(78,222,163,.08)] transition-all`}
                  initial={{ scaleY: 0 }}
                  animate={{ scaleY: 1 }}
                  transition={{ duration: 0.55, delay: bar.label === "Consumo" ? 0.07 : 0, ease: motionTokens.ease.enter }}
                  style={{ height: `${Math.max(4, (bar.amount / max) * 100)}%`, transformOrigin: "bottom" }}
                />
                <small className="muted absolute -bottom-4 left-1/2 -translate-x-1/2 whitespace-nowrap text-center text-[10px]">{bar.label}</small>
              </div>
            ))}
          </div>
        </>
      ) : (
        <Empty text="Registre receitas ou gastos para ver o fluxo do mês." />
      )}
    </section>
  );
}
function CategorySpendPreview({ sum }: { sum: ReturnType<typeof calculateSummary> }) {
  const palette = ["#4edea3", "#7c8cff", "#f7bd5c", "#f48ea7", "#50bce9"];
  const categories =
    sum.topCategories.length > 5
      ? [
          ...sum.topCategories.slice(0, 4),
          {
            category: "Outras",
            amountCents: sum.topCategories
              .slice(4)
              .reduce((value: number, item: any) => value + item.amountCents, 0),
          },
        ]
      : sum.topCategories;
  const total = categories.reduce((value: number, item: any) => value + item.amountCents, 0);
  const circumference = 2 * Math.PI * 39;
  const segments = categories.map((item: any, index: number) => {
    const length = (item.amountCents / total) * circumference;
    const preceding = categories
      .slice(0, index)
      .reduce((value: number, previous: any) => value + (previous.amountCents / total) * circumference, 0);
    return { ...item, color: palette[index], length, offset: -preceding };
  });
  return (
    <section className="panel rounded-2xl p-5">
      <div>
        <b>Gestão por categoria</b>
        <p className="muted mt-1 text-xs">Onde seu dinheiro foi neste mês</p>
      </div>
      {sum.topCategories.length ? (
        <div className="mt-5 grid grid-cols-[7.5rem_minmax(0,1fr)] items-center gap-4">
          <div className="relative grid h-[7.5rem] w-[7.5rem] place-items-center">
            <svg className="h-full w-full -rotate-90" viewBox="0 0 100 100" aria-label="Gráfico de pizza de gastos por categoria">
              <circle cx="50" cy="50" r="39" fill="none" stroke="var(--panel2)" strokeWidth="14" />
              {segments.map((item: any, index: number) => (
                <motion.circle
                  key={item.category}
                  cx="50"
                  cy="50"
                  r="39"
                  fill="none"
                  stroke={item.color}
                  strokeWidth="14"
                  initial={{ strokeDasharray: `0 ${circumference}` }}
                  animate={{ strokeDasharray: `${item.length} ${circumference}` }}
                  transition={{ duration: 0.65, delay: index * 0.06, ease: motionTokens.ease.enter }}
                  strokeDashoffset={item.offset}
                />
              ))}
            </svg>
            <span className="absolute text-center">
              <small className="muted block text-[10px]">Gastos</small>
              <b
                title={formatBRL(sum.expenseCents)}
                className="block max-w-[5.25rem] truncate text-xs"
              >
                {formatCompactBRL(sum.expenseCents)}
              </b>
            </span>
          </div>
          <div className="min-w-0 divide-y divide-[var(--border)]">
            {segments.slice(0, 4).map((item: any) => (
              <div className="flex min-w-0 items-center gap-2 py-2" key={item.category}>
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: item.color }} />
                <span className="min-w-0 flex-1 truncate text-xs">{item.category}</span>
                <b className="shrink-0 text-xs">{Math.round((item.amountCents / sum.expenseCents) * 100)}%</b>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <Empty text="Registre gastos para ver a distribuição." />
      )}
    </section>
  );
}
function AccountsDashboardPreview({ data, allTx, go }: any) {
  return (
    <section className="panel rounded-2xl p-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <b>Contas e cartões</b>
          <p className="muted mt-1 text-xs">Seus meios de pagamento</p>
        </div>
        <button onClick={() => go("accounts")} className="text-xs font-medium text-[var(--accent)]">
          Gerenciar
        </button>
      </div>
      {data.institutions.length ? (
        <div className="mt-4 divide-y divide-[var(--border)]">
          {data.institutions.slice(0, 4).map((institution: Institution) => {
            const balance = institution.accounts.reduce(
              (total: number, account: any) =>
                total + accountBalance(account.balance, `${institution.name} • ${account.name}`, allTx),
              0,
            );
            return (
              <div className="flex items-center justify-between gap-3 py-3" key={institution.id}>
                <span className="min-w-0">
                  <b className="block truncate text-sm">{institution.name}</b>
                  <small className="muted block">
                    {institution.accounts.length || 0} conta(s) · {institution.cards.length || 0} cartão(ões)
                  </small>
                </span>
                <b className="shrink-0 text-sm">{formatBRL(balance)}</b>
              </div>
            );
          })}
        </div>
      ) : (
        <Empty text="Nenhuma conta ou cartão cadastrado." />
      )}
    </section>
  );
}
function RecentStatementPreview({ tx, go }: { tx: FinanceTransaction[]; go: (view: View) => void }) {
  return (
    <section className="panel rounded-2xl p-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <b>Extrato recente</b>
          <p className="muted mt-1 text-xs">Últimas movimentações do mês</p>
        </div>
        <button onClick={() => go("statement")} className="text-xs font-medium text-[var(--accent)]">
          Ver extrato
        </button>
      </div>
      {tx.length ? (
        <div className="mt-4 divide-y divide-[var(--border)]">
          {tx.slice(0, 4).map((item) => {
            const positive = item.type === "income";
            const transfer = item.type === "transfer";
            const Icon = positive ? ArrowDownLeft : transfer ? WalletCards : item.type === "investment" ? BarChart3 : ArrowUpRight;
            const place = transfer ? `${item.account} → ${item.destinationAccount}` : item.account;
            return (
              <div
                className="grid grid-cols-[2.25rem_minmax(0,1fr)] gap-x-3 py-3 sm:grid-cols-[2.25rem_minmax(0,1fr)_auto] sm:items-center"
                key={item.id}
              >
                <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl ${positive ? "bg-[var(--accent)]/15 text-[var(--accent)]" : "bg-[var(--panel2)]"}`}>
                  <Icon size={16} />
                </span>
                <span className="min-w-0 flex-1">
                  <b className="block truncate text-sm">{item.description || item.category}</b>
                  <small className="muted mt-0.5 block truncate">
                    {transfer ? place : `${item.category} · ${place}`}
                  </small>
                  <small className="muted block text-[10px]">{format(new Date(item.date), "HH:mm")}</small>
                </span>
                <b className={`col-start-2 mt-1 justify-self-end whitespace-nowrap text-sm sm:col-start-auto sm:row-start-1 sm:mt-0 ${positive ? "text-[var(--accent)]" : item.type === "investment" ? "text-amber-400" : ""}`}>
                  {positive ? "+" : transfer ? "↔" : "−"}{formatBRL(item.amountCents)}
                </b>
              </div>
            );
          })}
        </div>
      ) : (
        <Empty text="Seu extrato está vazio." />
      )}
    </section>
  );
}
function CalendarDashboardPreview({ data, go }: any) {
  const today = new Date();
  const key = format(today, "yyyy-MM");
  const bills = (data.recurringBills || []).filter((bill: any) => bill.active);
  const nextSevenDays = Array.from({ length: 7 }, (_, offset) => new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset));
  const upcoming = nextSevenDays.flatMap((day) => {
    const monthKey = format(day, "yyyy-MM");
    return bills
      .filter((bill: any) => isRecurringBillScheduledInMonth(bill, monthKey) && !isRecurringBillPaidInMonth(bill, monthKey) && recurringBillDueDay(bill, monthKey) === day.getDate())
      .map((bill: any) => ({ bill, day }));
  }).slice(0, 3);
  const late = bills.filter((bill: any) => isRecurringBillScheduledInMonth(bill, key) && !isRecurringBillPaidInMonth(bill, key) && recurringBillDueDay(bill, key) < today.getDate()).length;
  return (
    <section className="panel rounded-2xl p-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="grid h-8 w-8 place-items-center rounded-xl bg-[var(--panel2)] text-[var(--accent)]">
            <CalendarDays size={16} />
          </span>
          <div>
            <b>Calendário financeiro</b>
            <p
              className={`mt-1 text-xs ${late ? "text-[var(--danger)]" : "muted"}`}
            >
              {late ? `${late} vencimento(s) atrasado(s)` : "Próximos 7 dias"}
            </p>
          </div>
        </div>
        <button
          onClick={() => go("planning")}
          className="text-xs font-medium text-[var(--accent)]"
        >
          Ver tudo
        </button>
      </div>
      <div className="mt-4 grid grid-cols-7 gap-1">
        {nextSevenDays.map((day) => {
          const dayMonth = format(day, "yyyy-MM");
          const dayBills = bills.filter(
            (bill: any) =>
              isRecurringBillScheduledInMonth(bill, dayMonth) &&
              !isRecurringBillPaidInMonth(bill, dayMonth) &&
              recurringBillDueDay(bill, dayMonth) === day.getDate(),
          );
          const active = day.toDateString() === today.toDateString();
          return (
            <div
              key={day.toISOString()}
              className={`min-h-14 rounded-xl p-1 text-center ${dayBills.length ? "bg-[var(--panel2)]" : ""}`}
            >
              <span className="muted block text-[9px] uppercase">
                {format(day, "EEEEE", { locale: ptBR })}
              </span>
              <b
                className={`mx-auto mt-1 grid h-6 w-6 place-items-center rounded-full text-xs ${active ? "bg-[var(--accent)] text-[var(--accentfg)]" : ""}`}
              >
                {format(day, "d")}
              </b>
              {dayBills.length ? (
                <i className="mx-auto mt-1 block h-1.5 w-1.5 rounded-full bg-amber-400" />
              ) : null}
            </div>
          );
        })}
      </div>
      {upcoming.length ? (
        <div className="mt-4 space-y-2">
          {upcoming.slice(0, 2).map(({ bill, day }: any) => (
            <div
              key={`${bill.id}-${day.toISOString()}`}
              className="flex items-center justify-between text-xs"
            >
              <span className="truncate">
                <b>{bill.name}</b>
                <small className="muted"> · {format(day, "dd/MM")}</small>
              </span>
              <b>{formatBRL(bill.amountCents)}</b>
            </div>
          ))}
        </div>
      ) : (
        <Empty text="Cadastre contas recorrentes para acompanhar seus vencimentos." />
      )}
    </section>
  );
}
function formatCompactBRL(cents: number) {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(cents / 100);
}
function FinancialEvolution({ allTx }: { allTx: FinanceTransaction[] }) {
  const months = Array.from({ length: 6 }, (_, offset) =>
    startOfMonth(addMonths(new Date(), offset - 5)),
  );
  const points = months.map((date) => {
    const key = format(date, "yyyy-MM");
    const monthItems = allTx.filter((item) => item.date.startsWith(key));
    const summary = calculateSummary(monthItems);
    const balance = calculateSummary(
      allTx.filter((item) => item.date < addMonths(date, 1).toISOString()),
    ).balanceCents;
    return {
      key,
      label: format(date, "MMM", { locale: ptBR }),
      income: summary.incomeCents,
      expense: summary.expenseCents,
      balance,
    };
  });
  const maximum = Math.max(
    1,
    ...points.flatMap((item) => [item.income, item.expense]),
  );
  const balanceMin = Math.min(...points.map((item) => item.balance), 0);
  const balanceMax = Math.max(...points.map((item) => item.balance), 1);
  const line = points
    .map(
      (item, index) =>
        `${(index / Math.max(1, points.length - 1)) * 100},${100 - ((item.balance - balanceMin) / (balanceMax - balanceMin || 1)) * 82 - 9}`,
    )
    .join(" ");
  const currentBalance = points.at(-1)?.balance || 0;
  const currentFlow = (points.at(-1)?.income || 0) - (points.at(-1)?.expense || 0);
  return (
    <section className="panel rounded-2xl p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <b>Evolução financeira</b>
          <p className="muted mt-1 text-xs">
            Receitas, consumo e saldo acumulado
          </p>
        </div>
        <span className="shrink-0 rounded-full bg-[var(--accent)]/15 px-2.5 py-1 text-xs font-medium text-[var(--accent)]">6 meses</span>
      </div>
      {allTx.length ? (
        <>
          <div className="mt-5 grid grid-cols-2 gap-3">
            <div className="rounded-xl bg-[var(--panel2)] p-3">
              <span className="muted block text-[11px]">Saldo acumulado</span>
              <b title={formatBRL(currentBalance)} className="mt-1 block text-sm">
                {formatCompactBRL(currentBalance)}
              </b>
            </div>
            <div className="rounded-xl bg-[var(--panel2)] p-3">
              <span className="muted block text-[11px]">Resultado atual</span>
              <b title={formatBRL(currentFlow)} className={`mt-1 block text-sm ${currentFlow < 0 ? "text-[var(--danger)]" : "text-[var(--accent)]"}`}>
                {currentFlow >= 0 ? "+" : ""}{formatCompactBRL(currentFlow)}
              </b>
            </div>
          </div>
          <div className="relative mt-4 h-48 overflow-hidden rounded-2xl bg-[var(--panel2)] px-3 pb-4 pt-3">
            <svg
              className="absolute inset-0 h-full w-full overflow-visible"
              viewBox="0 0 100 100"
              preserveAspectRatio="none"
              aria-label="Linha de evolução do saldo"
            >
              {[25, 50, 75].map((y) => (
                <line
                  key={y}
                  x1="0"
                  x2="100"
                  y1={y}
                  y2={y}
                  stroke="var(--border)"
                  strokeWidth="0.6"
                  vectorEffect="non-scaling-stroke"
                />
              ))}
              <motion.polyline
                fill="none"
                stroke="var(--accent)"
                strokeWidth="2.5"
                vectorEffect="non-scaling-stroke"
                points={line}
                initial={{ pathLength: 0, opacity: 0.4 }}
                animate={{ pathLength: 1, opacity: 1 }}
                transition={{ duration: 0.7, ease: motionTokens.ease.enter }}
              />
            </svg>
            <div className="absolute inset-x-5 bottom-4 top-4 flex items-end justify-around gap-2">
              {points.map((item) => (
                <div
                  key={item.key}
                  className="flex h-full flex-1 items-end gap-1"
                >
                  <motion.span
                    title={`Receitas: ${formatBRL(item.income)}`}
                    className="min-h-1 flex-1 rounded-t bg-[var(--accent)]/80"
                    initial={{ scaleY: 0 }}
                    animate={{ scaleY: 1 }}
                    transition={{ duration: 0.55, delay: 0.05, ease: motionTokens.ease.enter }}
                    style={{
                      height: `${Math.max(3, (item.income / maximum) * 68)}%`,
                      transformOrigin: "bottom",
                    }}
                  />
                  <motion.span
                    title={`Consumo: ${formatBRL(item.expense)}`}
                    className="min-h-1 flex-1 rounded-t bg-[var(--danger)]/70"
                    initial={{ scaleY: 0 }}
                    animate={{ scaleY: 1 }}
                    transition={{ duration: 0.55, delay: 0.12, ease: motionTokens.ease.enter }}
                    style={{
                      height: `${Math.max(3, (item.expense / maximum) * 68)}%`,
                      transformOrigin: "bottom",
                    }}
                  />
                </div>
              ))}
            </div>
          </div>
          <div className="muted mt-3 flex justify-around px-2 text-[10px]">
            {points.map((item) => (
              <span key={item.key}>{item.label}</span>
            ))}
          </div>
          <div className="muted mt-4 flex gap-4 text-xs">
            <span>
              <i className="mr-1 inline-block h-2 w-2 rounded-full bg-[var(--accent)]" />
              Receitas
            </span>
            <span>
              <i className="mr-1 inline-block h-2 w-2 rounded-full bg-[var(--danger)]" />
              Consumo
            </span>
            <span>
              <i className="mr-1 inline-block h-2 w-2 rounded-full bg-[var(--accent)]" />
              Saldo
            </span>
          </div>
        </>
      ) : (
        <Empty text="Registre movimentações para visualizar o comparativo dos últimos meses." />
      )}
    </section>
  );
}
function ImprovementsPanel({ data, tx, sum }: any) {
  const insights: string[] = [];
  const today = new Date();
  const budgets = data.budgets || [];
  budgets.forEach((budget: any) => {
    const spent = tx
      .filter(
        (item: FinanceTransaction) =>
          item.type === "expense" && item.category === budget.category,
      )
      .reduce(
        (total: number, item: FinanceTransaction) => total + item.amountCents,
        0,
      );
    const left = budget.limitCents - spent;
    if (spent >= budget.limitCents)
      insights.push(
        `${budget.category}: limite ultrapassado em ${formatBRL(Math.abs(left))}.`,
      );
    else if (spent / budget.limitCents >= 0.8)
      insights.push(
        `${budget.category}: restam ${formatBRL(left)} do orçamento.`,
      );
  });
  (data.goals || []).forEach((goal: any) => {
    if (goal.targetDate)
      insights.push(
        `${goal.name}: reserve ${formatBRL(monthlyContributionNeeded(goal.targetCents, goal.currentCents, goal.targetDate))}/mês para chegar ao prazo.`,
      );
  });
  const todayMonth = format(today, "yyyy-MM");
  (data.recurringBills || [])
    .filter((bill: any) => isRecurringBillScheduledInMonth(bill, todayMonth) && !isRecurringBillPaidInMonth(bill, todayMonth))
    .map((bill: any) => ({ bill, dueDay: recurringBillDueDay(bill, todayMonth) }))
    .filter(({ dueDay }: { dueDay: number }) => dueDay >= today.getDate() && dueDay - today.getDate() <= 3)
    .forEach(({ bill, dueDay }: { bill: any; dueDay: number }) =>
      insights.push(`${bill.name} vence em ${dueDay - today.getDate()} dia(s).`),
    );
  if (!insights.length && (sum.incomeCents || sum.expenseCents))
    insights.push(
      `Seu consumo está em ${formatBRL(sum.expenseCents)} neste mês. Continue registrando para receber melhorias mais específicas.`,
    );
  return (
    <section className="panel rounded-2xl p-5">
      <div className="flex items-center gap-2">
        <span className="grid h-8 w-8 place-items-center rounded-xl bg-[var(--accent)]/15 text-[var(--accent)]">
          <CirclePlus size={16} />
        </span>
        <div>
          <b>Melhorias para você</b>
          <p className="muted text-xs">Diagnóstico automático, sem IA</p>
        </div>
      </div>
      {insights.length ? (
        <div className="mt-4 space-y-3">
          {insights.slice(0, 3).map((insight, index) => (
            <div
              key={index}
              className="rounded-xl bg-[var(--panel2)] p-3 text-sm leading-5"
            >
              {insight}
            </div>
          ))}
        </div>
      ) : (
        <Empty text="Cadastre orçamento, metas ou contas recorrentes para receber recomendações práticas." />
      )}
    </section>
  );
}
function K({ l, v }: any) {
  return (
    <div className="min-w-0">
      <p className="muted text-xs">{l}</p>
      <b
        title={formatBRL(v)}
        className="mt-1 block whitespace-nowrap text-[clamp(.72rem,3.1vw,1rem)] leading-tight tracking-tight"
      >
        <AnimatedNumber cents={v} />
      </b>
    </div>
  );
}
function Mini({ title, text }: any) {
  return (
    <section className="panel rounded-2xl p-5">
      <b>{title}</b>
      <Empty text={text} />
    </section>
  );
}
function PreviewHeader({
  icon,
  title,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  action: () => void;
}) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2">
        <span className="grid h-8 w-8 place-items-center rounded-xl bg-[var(--panel2)] text-[var(--accent)]">
          {icon}
        </span>
        <b>{title}</b>
      </div>
      <button
        onClick={action}
        className="text-xs font-medium text-[var(--accent)]"
      >
        Ver tudo
      </button>
    </div>
  );
}
function BudgetPreview({ data, tx, go }: any) {
  const budget = data.budgets?.[0];
  if (!budget)
    return (
      <section className="panel rounded-2xl p-5">
        <PreviewHeader
          icon={<PiggyBank size={16} />}
          title="Orçamentos"
          action={() => go("budgets")}
        />
        <Empty text="Crie um limite mensal para acompanhar seus gastos." />
        <button
          onClick={() => go("budgets")}
          className="mt-4 text-sm font-medium text-[var(--accent)]"
        >
          Criar orçamento
        </button>
      </section>
    );
  const spent = tx
    .filter(
      (item: FinanceTransaction) =>
        item.type === "expense" &&
        item.category === budget.category &&
        item.date.startsWith(budget.month),
    )
    .reduce(
      (total: number, item: FinanceTransaction) => total + item.amountCents,
      0,
    );
  const percentage = Math.min(
    100,
    Math.round((spent / budget.limitCents) * 100),
  );
  return (
    <section className="panel rounded-2xl p-5">
      <PreviewHeader
        icon={<PiggyBank size={16} />}
        title="Orçamentos"
        action={() => go("budgets")}
      />
      <div className="mt-5">
        <div className="flex justify-between text-sm">
          <span>{budget.category}</span>
          <span className="muted">{percentage}%</span>
        </div>
        <div className="mt-3 h-2 overflow-hidden rounded-full bg-[var(--panel2)]">
          <AnimatedProgress
            value={percentage}
            className="block h-full rounded-full bg-[var(--accent)]"
          />
        </div>
        <p className="muted mt-3 text-xs">
          {formatBRL(spent)} usado de {formatBRL(budget.limitCents)}
        </p>
      </div>
    </section>
  );
}
function GoalPreview({ data, go, sharedGoals = [] }: { data: Data; go: (view: View) => void; sharedGoals?: SharedGoalSummary[] }) {
  const personalGoals = (data.goals || []).map((goal) => {
    const shared = sharedGoals.find((candidate) => candidate.id === goal.sharedGoalId);
    return {
      id: goal.id,
      name: shared?.name || goal.name,
      currentCents: shared?.current_cents ?? goal.currentCents,
      targetCents: shared?.target_cents ?? goal.targetCents,
      shared: Boolean(goal.sharedGoalId),
    };
  });
  const linkedIds = new Set((data.goals || []).map((goal) => goal.sharedGoalId).filter(Boolean));
  const receivedGoals = sharedGoals
    .filter((goal) => !linkedIds.has(goal.id))
    .map((goal) => ({
      id: goal.id,
      name: goal.name,
      currentCents: goal.current_cents,
      targetCents: goal.target_cents,
      shared: true,
    }));
  const goals = [...personalGoals, ...receivedGoals].slice(0, 2);
  if (!goals.length)
    return (
      <section className="panel rounded-2xl p-5">
        <PreviewHeader
          icon={<Target size={16} />}
          title="Metas"
          action={() => go("goals")}
        />
        <Empty text="Transforme um plano em um objetivo financeiro." />
        <button
          onClick={() => go("goals")}
          className="mt-4 text-sm font-medium text-[var(--accent)]"
        >
          Criar meta
        </button>
      </section>
    );
  return (
    <section className="panel rounded-2xl p-5">
      <PreviewHeader
        icon={<Target size={16} />}
        title="Metas"
        action={() => go("goals")}
      />
      <div className="mt-5 space-y-4">
        {goals.map((goal) => {
          const percentage = goal.targetCents > 0
            ? Math.min(100, Math.round((goal.currentCents / goal.targetCents) * 100))
            : 0;
          return <div key={goal.id}>
            <div className="flex min-w-0 items-center justify-between gap-3 text-sm">
              <span className="min-w-0 truncate">{goal.name}<small className="muted ml-2">{goal.shared ? "Compartilhada" : "Pessoal"}</small></span>
              <span className="shrink-0 muted">{percentage}%</span>
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-[var(--panel2)]">
              <AnimatedProgress value={percentage} className="block h-full rounded-full bg-[var(--accent)]" />
            </div>
            <p className="muted mt-2 text-xs">{formatBRL(goal.currentCents)} de {formatBRL(goal.targetCents)}</p>
          </div>;
        })}
      </div>
    </section>
  );
}
function InvestmentPreview({ data, go }: any) {
  const items = data.investments || [];
  const palette = ["#4edea3", "#7c8cff", "#f7bd5c", "#f48ea7", "#50bce9"];
  const contributed = items.reduce(
    (total: number, item: any) => total + item.contributedCents,
    0,
  );
  const current = items.reduce(
    (total: number, item: any) =>
      total + (item.currentCents ?? item.contributedCents),
    0,
  );
  const first = items[0];
  if (!first)
    return (
      <section className="panel rounded-2xl p-5">
        <PreviewHeader
          icon={<BarChart3 size={16} />}
          title="Investimentos"
          action={() => go("investments")}
        />
        <Empty text="Cadastre um investimento para acompanhar seus aportes." />
        <button
          onClick={() => go("investments")}
          className="mt-4 text-sm font-medium text-[var(--accent)]"
        >
          Adicionar investimento
        </button>
      </section>
    );
  return (
    <section className="panel rounded-2xl p-5">
      <PreviewHeader
        icon={<BarChart3 size={16} />}
        title="Investimentos"
        action={() => go("investments")}
      />
      <div className="mt-5">
        <p className="text-sm">{first.name}</p>
        <b className="mt-1 block text-xl"><AnimatedNumber cents={current} /></b>
        <div className="mt-4 flex gap-5 text-xs">
          <span className="muted">
            Aportado{" "}
            <b className="ml-1 text-[var(--fg)]"><AnimatedNumber cents={contributed} /></b>
          </span>
          <span className="muted">
            Posições <b className="ml-1 text-[var(--fg)]">{items.length}</b>
          </span>
        </div>
        <div className="mt-5">
          <div className="flex items-center justify-between text-xs">
            <span className="muted">Distribuição dos aportes</span>
            <span className="font-medium">{items.length} posição(ões)</span>
          </div>
          <div className="mt-2 flex h-2 overflow-hidden rounded-full bg-[var(--panel2)]">
            {items.map((item: any, index: number) => (
              <motion.span
                key={item.id}
                title={`${item.name}: ${formatBRL(item.contributedCents)}`}
                className="h-full transition-all"
                initial={{ scaleX: 0 }}
                animate={{ scaleX: 1 }}
                transition={{ duration: 0.55, delay: index * 0.06, ease: motionTokens.ease.enter }}
                style={{
                  width: `${Math.max(1, (item.contributedCents / Math.max(contributed, 1)) * 100)}%`,
                  backgroundColor: palette[index % palette.length],
                  transformOrigin: "left center",
                }}
              />
            ))}
          </div>
          <p className="muted mt-2 truncate text-xs">
            <span className="mr-1 inline-block h-2 w-2 rounded-full bg-[var(--accent)]" />
            {first.name}: {Math.round((first.contributedCents / Math.max(contributed, 1)) * 100)}% dos aportes
          </p>
        </div>
      </div>
    </section>
  );
}
function ModuleEmpty({
  title,
  text,
  action,
}: {
  title: string;
  text: string;
  action: string;
}) {
  return (
    <section className="mx-auto max-w-3xl px-4 pt-8">
      <h1 className="text-2xl font-semibold">{title}</h1>
      <section className="panel mt-5 rounded-2xl p-5">
        <Empty text={text} />
        <button className="primary mt-5 rounded-xl px-4 py-3 text-sm">
          {action}
        </button>
      </section>
    </section>
  );
}
function SectionTitle({
  title,
  help,
  onAdd,
  addLabel = "Adicionar",
}: {
  title: string;
  help: string;
  onAdd?: () => void;
  addLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative flex items-center gap-2">
      <h1 className="text-2xl font-semibold">{title}</h1>
      <button
        aria-label={`Como funciona ${title}`}
        onClick={() => setOpen(!open)}
        className="muted grid h-11 w-11 place-items-center rounded-full bg-[var(--panel2)] hover:text-[var(--accent)]"
      >
        <CircleHelp size={17} />
      </button>
      {onAdd && (
        <button
          aria-label={addLabel}
          onClick={onAdd}
          className="primary ml-auto grid h-11 w-11 place-items-center rounded-xl shadow-sm"
        >
          <Plus size={18} />
        </button>
      )}
      {open && (
        <div
          role="status"
          className="panel absolute left-0 top-11 z-30 w-[min(340px,calc(100vw-2rem))] rounded-2xl p-4 shadow-2xl"
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <b className="text-sm">Como funciona</b>
              <p className="muted mt-1 text-sm leading-6">{help}</p>
            </div>
            <button aria-label="Fechar ajuda" onClick={() => setOpen(false)}>
              <X size={16} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
function ItemActions({ onEdit, onDelete, label, className = "mt-3" }: { onEdit: () => void; onDelete: () => void; label: string; className?: string }) {
  return <div className={`${className} flex items-center gap-3 text-xs`}>
    <button onClick={onEdit} className="inline-flex items-center gap-1.5 font-medium text-[var(--accent)]" aria-label={`Editar ${label}`}><Pencil size={14} />Editar</button>
    <button onClick={onDelete} className="inline-flex items-center gap-1.5 font-medium text-[var(--danger)]" aria-label={`Excluir ${label}`}><Trash2 size={14} />Excluir</button>
  </div>;
}
function DeleteConfirm({ title, description, confirm, close }: { title: string; description: string; confirm: () => void; close: () => void }) {
  return <Sheet close={close}><section className="space-y-4"><div><b className="text-lg">{title}</b><p className="muted mt-2 text-sm leading-6">{description}</p></div><div className="flex gap-2"><button onClick={close} className="h-11 flex-1 rounded-xl bg-[var(--panel2)] text-sm font-medium">Cancelar</button><button onClick={confirm} className="h-11 flex-1 rounded-xl bg-[var(--danger)] px-3 text-sm font-semibold text-white">Excluir</button></div></section></Sheet>;
}
function centsInput(value?: number) {
  return value === undefined ? "" : (value / 100).toFixed(2).replace(".", ",");
}
function financialAccountOptions(data: Data) {
  return (data.institutions || []).flatMap((institution) =>
    institution.accounts.map((account) => ({
      value: `${institution.name} • ${account.name}`,
      label: `${institution.name} • ${account.name}`,
    })),
  );
}
function dateAtLocalNoon(date: string) {
  return new Date(`${date}T12:00:00`).toISOString();
}
function isFutureFinancialDay(date: string) {
  return format(new Date(date), "yyyy-MM-dd") > format(new Date(), "yyyy-MM-dd");
}
function Investments({ data, transactions = [], save, saveTransactions, toast }: any) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<any | null>(null);
  const [deleting, setDeleting] = useState<any | null>(null);
  const [name, setName] = useState("");
  const [contributed, setContributed] = useState("");
  const [current, setCurrent] = useState("");
  const [assetClass, setAssetClass] = useState("Renda fixa");
  const [rate, setRate] = useState("");
  const [aporteFor, setAporteFor] = useState("");
  const [aporte, setAporte] = useState("");
  const [aporteAccount, setAporteAccount] = useState("");
  const [aporteDate, setAporteDate] = useState(format(new Date(), "yyyy-MM-dd"));
  const items = data.investments || [];
  const accounts = financialAccountOptions(data);
  const persist = () => {
    const cents = Math.round(Number(contributed.replace(",", ".")) * 100);
    const currentCents = current.trim()
      ? Math.round(Number(current.replace(",", ".")) * 100)
      : undefined;
    if (!name.trim() || !Number.isSafeInteger(cents) || cents <= 0 || (currentCents !== undefined && (!Number.isSafeInteger(currentCents) || currentCents < 0))) {
      toast("Informe o nome e saldos válidos para o investimento.");
      return;
    }
    const item = {
      id: editing?.id || crypto.randomUUID(),
      name: name.trim(),
      contributedCents: cents,
      ...(currentCents === undefined
        ? {}
        : { currentCents }),
      assetClass,
      expectedAnnualRate: rate ? Number(rate.replace(",", ".")) : undefined,
    };
    save({
      ...data,
      investments: editing ? items.map((value: any) => value.id === editing.id ? item : value) : [...items, item],
    });
    toast(editing ? "Investimento atualizado com sucesso." : "Investimento salvo com sucesso.");
    setName("");
    setContributed("");
    setCurrent("");
    setAssetClass("Renda fixa");
    setRate("");
    setAdding(false);
    setEditing(null);
  };
  const startEdit = (item: any) => { setEditing(item); setName(item.name); setContributed(centsInput(item.contributedCents)); setCurrent(centsInput(item.currentCents)); setAssetClass(item.assetClass || "Renda fixa"); setRate(item.expectedAnnualRate?.toString().replace(".", ",") || ""); };
  const addAporte = () => {
    const cents = Math.round(Number(aporte.replace(",", ".")) * 100);
    const investment = items.find((item: any) => item.id === aporteFor);
    if (!investment || !Number.isSafeInteger(cents) || cents <= 0 || !aporteAccount || !aporteDate) {
      toast("Informe um valor positivo, a conta de origem e a data do aporte.");
      return;
    }
    const transaction: FinanceTransaction = {
      id: crypto.randomUUID(),
      type: "investment",
      subtype: "investment_contribution",
      amountCents: cents,
      category: investment.name,
      account: aporteAccount,
      description: `Aporte • ${investment.name}`,
      date: dateAtLocalNoon(aporteDate),
      createdAt: new Date().toISOString(),
      investmentId: investment.id,
    };
    saveTransactions([...transactions, transaction]);
    toast("Aporte registrado com sucesso.");
    setAporte("");
    setAporteFor("");
    setAporteAccount("");
    setAporteDate(format(new Date(), "yyyy-MM-dd"));
  };
  return (
    <section className="mx-auto max-w-3xl px-4 pt-8">
      <SectionTitle
        title="Investimentos"
        help="Cadastre cada investimento uma vez. Depois, use “Registrar aporte” sempre que colocar mais dinheiro nele."
        onAdd={() => setAdding(true)}
        addLabel="Adicionar investimento"
      />
      <p className="muted mt-2 text-sm">
        Acompanhe aportes e valor atual informado manualmente.
      </p>
      {items.length ? (
        <div className="mt-5 space-y-3">
          {items.map((item: any) => (
            <article className="panel rounded-2xl p-4" key={item.id}>
              <b>{item.name}</b>
              <p className="muted mt-1 text-sm">
                Aportado {formatBRL(item.contributedCents)}
                {item.currentCents !== undefined
                  ? ` · Atual ${formatBRL(item.currentCents)}`
                  : ""}
              </p>
              <div className="mt-2 flex items-center justify-between text-xs">
                <span className="rounded-full bg-[var(--panel2)] px-2 py-1">
                  {item.assetClass || "Outros"}
                </span>
                {item.currentCents !== undefined && (
                  <span
                    className={
                      item.currentCents - item.contributedCents >= 0
                        ? "text-[var(--accent)]"
                        : "text-[var(--danger)]"
                    }
                  >
                    {item.currentCents >= item.contributedCents ? "+" : ""}
                    {formatBRL(item.currentCents - item.contributedCents)}
                  </span>
                )}
              </div>
              {transactions.some((transaction: FinanceTransaction) => transaction.investmentId === item.id) && (
                <div className="mt-4 border-t border-[var(--border)] pt-3">
                  <p className="muted text-[11px] font-semibold uppercase tracking-wide">Últimos aportes</p>
                  <div className="mt-2 space-y-2">
                    {transactions
                      .filter((transaction: FinanceTransaction) => transaction.investmentId === item.id)
                      .sort((a: FinanceTransaction, b: FinanceTransaction) => b.date.localeCompare(a.date))
                      .slice(0, 3)
                      .map((transaction: FinanceTransaction) => (
                        <div className="flex items-center justify-between gap-3 text-xs" key={transaction.id}>
                          <span className="min-w-0 truncate muted">
                            {format(new Date(transaction.date), "dd/MM/yyyy")} · {transaction.account}
                          </span>
                          <b className="shrink-0">+{formatBRL(transaction.amountCents)}</b>
                        </div>
                      ))}
                  </div>
                </div>
              )}
              <button
                onClick={() => {
                  setAporteFor(item.id);
                  setAporte("");
                  setAporteAccount("");
                  setAporteDate(format(new Date(), "yyyy-MM-dd"));
                }}
                className="mt-3 text-sm font-medium text-[var(--accent)]"
              >
                + Registrar aporte
              </button>
              <ItemActions label={`o investimento ${item.name}`} onEdit={() => startEdit(item)} onDelete={() => setDeleting(item)} />
            </article>
          ))}
        </div>
      ) : (
        <Empty text="Você ainda não possui investimentos cadastrados." />
      )}
      {aporteFor && (
        <Sheet close={() => setAporteFor("")}>
          <section className="space-y-3">
            <b className="text-lg">Registrar aporte</b>
            <p className="muted text-sm">
              O aporte reduz o saldo da conta escolhida e fica no extrato ligado a este investimento.
            </p>
            <input
              autoFocus
              aria-label="Valor do aporte"
              className="field"
              value={aporte}
              onChange={(event) => setAporte(event.target.value)}
              inputMode="decimal"
              placeholder="Valor do aporte"
            />
            <label className="block text-sm">
              Conta de origem
              <select className="field mt-1" value={aporteAccount} onChange={(event) => setAporteAccount(event.target.value)}>
                <option value="">Selecione a conta</option>
                {accounts.map((account: { value: string; label: string }) => <option key={account.value} value={account.value}>{account.label}</option>)}
              </select>
            </label>
            <label className="block text-sm">
              Data do aporte
              <input className="field mt-1" type="date" max={format(new Date(), "yyyy-MM-dd")} value={aporteDate} onChange={(event) => setAporteDate(event.target.value)} />
            </label>
            {!accounts.length && <p className="muted rounded-xl bg-[var(--panel2)] p-3 text-xs">Cadastre uma conta antes de registrar um aporte.</p>}
            <button disabled={!accounts.length} onClick={addAporte} className="primary h-11 w-full rounded-xl text-sm disabled:opacity-50">
              Confirmar aporte
            </button>
          </section>
        </Sheet>
      )}
      {(adding || editing) && (
        <Sheet close={() => { setAdding(false); setEditing(null); }}>
          <section className="space-y-3">
            <b className="text-lg">{editing ? "Editar investimento" : "Novo investimento"}</b>
            <input
              className="field"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Nome do investimento"
            />
            <input
              className="field"
              value={contributed}
              onChange={(e) => setContributed(e.target.value)}
              inputMode="decimal"
              placeholder="Saldo já investido"
            />
            <p className="muted -mt-1 text-xs leading-5">
              Este é o saldo inicial já aplicado; não movimenta uma conta. Novos depósitos devem ser registrados em “Registrar aporte”.
            </p>
            <input
              className="field"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              inputMode="decimal"
              placeholder="Valor atual (opcional)"
            />
            <select
              className="field"
              value={assetClass}
              onChange={(e) => setAssetClass(e.target.value)}
            >
              <option>Reserva de emergência</option>
              <option>Renda fixa</option>
              <option>CDB</option>
              <option>Tesouro</option>
              <option>Ações</option>
              <option>ETF</option>
              <option>Fundo</option>
              <option>Cripto</option>
              <option>Outros</option>
            </select>
            <input
              className="field"
              value={rate}
              onChange={(e) => setRate(e.target.value)}
              inputMode="decimal"
              placeholder="Rentabilidade anual estimada % (opcional)"
            />
            <button
              onClick={persist}
              className="primary h-11 w-full rounded-xl text-sm"
            >
              {editing ? "Salvar alterações" : "Salvar investimento"}
            </button>
          </section>
        </Sheet>
      )}
      {deleting && <DeleteConfirm title="Excluir investimento?" description={`“${deleting.name}” será removido da sua carteira. Essa ação não altera lançamentos já existentes.`} close={() => setDeleting(null)} confirm={() => { save({ ...data, investments: items.filter((item: any) => item.id !== deleting.id) }); toast("Investimento excluído."); setDeleting(null); }} />}
    </section>
  );
}
function Budgets({ data, tx, month, save, toast }: any) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<any | null>(null);
  const [deleting, setDeleting] = useState<any | null>(null);
  const [category, setCategory] = useState("");
  const [limit, setLimit] = useState("");
  const items = data.budgets || [];
  const persist = () => {
    const cents = Math.round(Number(limit.replace(",", ".")) * 100);
    if (!category.trim() || !cents) return;
    save({
      ...data,
      budgets: editing ? items.map((item: any) => item.id === editing.id ? { ...item, category: category.trim(), limitCents: cents } : item) : [...items, { id: crypto.randomUUID(), category: category.trim(), limitCents: cents, month: format(month, "yyyy-MM") }],
    });
    toast(editing ? "Orçamento atualizado com sucesso." : "Orçamento criado com sucesso.");
    setCategory("");
    setLimit("");
    setAdding(false);
    setEditing(null);
  };
  const startEdit = (item: any) => { setEditing(item); setCategory(item.category); setLimit(centsInput(item.limitCents)); };
  return (
    <section className="mx-auto max-w-3xl px-4 pt-8">
      <SectionTitle
        title="Orçamentos"
        help="Defina um limite mensal para uma categoria. Cada gasto registrado naquela categoria atualiza a barra automaticamente."
        onAdd={() => setAdding(true)}
        addLabel="Adicionar orçamento"
      />
      <p className="muted mt-2 text-sm">
        Defina limites mensais por categoria.
      </p>
      {items.length ? (
        <div className="mt-5 space-y-3">
          {items.map((item: any) => {
            const spent = tx
              .filter(
                (transaction: FinanceTransaction) =>
                  transaction.type === "expense" &&
                  transaction.category === item.category &&
                  transaction.date.startsWith(item.month),
              )
              .reduce(
                (total: number, transaction: FinanceTransaction) =>
                  total + transaction.amountCents,
                0,
              );
            const percentage = Math.round((spent / item.limitCents) * 100);
            return (
              <article className="panel rounded-2xl p-4" key={item.id}>
                <div className="flex justify-between gap-3">
                  <b>{item.category}</b>
                  <span className="text-sm">{Math.min(percentage, 999)}%</span>
                </div>
                <div className="mt-3 h-2 overflow-hidden rounded-full bg-[var(--panel2)]">
                  <AnimatedProgress
                    value={Math.min(100, percentage)}
                    className="block h-full bg-[var(--accent)]"
                  />
                </div>
                <p className="muted mt-2 text-sm">
                  {formatBRL(spent)} de {formatBRL(item.limitCents)} neste mês
                </p>
                <ItemActions label={`o orçamento de ${item.category}`} onEdit={() => startEdit(item)} onDelete={() => setDeleting(item)} />
              </article>
            );
          })}
        </div>
      ) : (
        <Empty text="Nenhum orçamento criado." />
      )}
      {(adding || editing) && (
        <Sheet close={() => { setAdding(false); setEditing(null); }}>
          <section className="space-y-3">
            <b className="text-lg">{editing ? "Editar orçamento" : "Criar orçamento"}</b>
            <input
              className="field"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              placeholder="Categoria que você quer controlar"
              list="budget-categories"
            />
            <datalist id="budget-categories">
              {data.categories.map((item: string) => (
                <option value={item} key={item} />
              ))}
            </datalist>
            <input
              className="field"
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              inputMode="decimal"
              placeholder="Limite mensal"
            />
            <button
              onClick={persist}
              className="primary h-11 w-full rounded-xl text-sm"
            >
              {editing ? "Salvar alterações" : "Criar orçamento"}
            </button>
          </section>
        </Sheet>
      )}
      {deleting && <DeleteConfirm title="Excluir orçamento?" description={`O limite de “${deleting.category}” deixará de ser acompanhado neste mês; seus lançamentos continuam preservados.`} close={() => setDeleting(null)} confirm={() => { save({ ...data, budgets: items.filter((item: any) => item.id !== deleting.id) }); toast("Orçamento excluído."); setDeleting(null); }} />}
    </section>
  );
}
function Goals({ data, transactions = [], save, saveTransactions, toast, invites = [], respondInvite, sharedGoals = [], recordSharedGoalContribution, userId, allowSharing = true }: any) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<any | null>(null);
  const [deleting, setDeleting] = useState<any | null>(null);
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  const [current, setCurrent] = useState("");
  const [targetDate, setTargetDate] = useState("");
  const [contributionFor, setContributionFor] = useState("");
  const [contribution, setContribution] = useState("");
  const [contributionAccount, setContributionAccount] = useState("");
  const [contributionDate, setContributionDate] = useState(format(new Date(), "yyyy-MM-dd"));
  const [savingContribution, setSavingContribution] = useState(false);
  const [sharingGoal, setSharingGoal] = useState<any | null>(null);
  const [recipientId, setRecipientId] = useState("");
  const [sharing, setSharing] = useState(false);
  const items = data.goals || [];
  const accounts = financialAccountOptions(data);
  const linkedSharedIds = new Set(items.map((item: any) => item.sharedGoalId).filter(Boolean));
  const receivedSharedGoals = (sharedGoals as SharedGoalSummary[]).filter((goal) => !linkedSharedIds.has(goal.id));
  const persist = () => {
    const targetCents = Math.round(Number(target.replace(",", ".")) * 100);
    const parsedCurrent = current.trim() ? Number(current.replace(",", ".")) : 0;
    const currentCents = Math.round(parsedCurrent * 100);
    if (!name.trim() || !Number.isSafeInteger(targetCents) || targetCents <= 0 || !Number.isFinite(parsedCurrent) || !Number.isSafeInteger(currentCents) || currentCents < 0) {
      toast("Informe um nome e valores válidos para a meta.");
      return;
    }
    const linkedContributions = editing
      ? transactions
          .filter((transaction: FinanceTransaction) => transaction.type === "transfer" && transaction.goalId === editing.id)
          .reduce((total: number, transaction: FinanceTransaction) => total + transaction.amountCents, 0)
      : 0;
    if (currentCents < linkedContributions) {
      toast("O saldo da meta não pode ficar abaixo das contribuições registradas.");
      return;
    }
    save({
      ...data,
      goals: editing ? items.map((item: any) => item.id === editing.id ? { ...item, name: name.trim(), targetCents, currentCents, targetDate: targetDate || undefined } : item) : [...items, { id: crypto.randomUUID(), name: name.trim(), targetCents, currentCents, targetDate: targetDate || undefined }],
    });
    toast(editing ? "Meta atualizada com sucesso." : "Meta criada com sucesso.");
    setName("");
    setTarget("");
    setCurrent("");
    setTargetDate("");
    setAdding(false);
    setEditing(null);
  };
  const startEdit = (item: any) => { setEditing(item); setName(item.name); setTarget(centsInput(item.targetCents)); setCurrent(centsInput(item.currentCents)); setTargetDate(item.targetDate || ""); };
  const contribute = async () => {
    const cents = Math.round(Number(contribution.replace(",", ".")) * 100);
    const goal = items.find((item: any) => item.id === contributionFor);
    const sharedGoal = contributionFor.startsWith("shared:")
      ? (sharedGoals as SharedGoalSummary[]).find((item) => item.id === contributionFor.slice("shared:".length))
      : null;
    const linkedSharedGoal = goal?.sharedGoalId
      ? (sharedGoals as SharedGoalSummary[]).find((item) => item.id === goal.sharedGoalId)
      : null;
    if (goal?.sharedGoalId && !linkedSharedGoal) {
      toast("Aguarde a sincronização desta meta compartilhada e tente novamente.");
      return;
    }
    if ((!goal && !sharedGoal) || !Number.isSafeInteger(cents) || cents <= 0 || !contributionAccount || !contributionDate) {
      toast("Informe um valor positivo, a conta de origem e a data da contribuição.");
      return;
    }
    const destination = sharedGoal || linkedSharedGoal;
    if (destination) {
      setSavingContribution(true);
      const saved = await recordSharedGoalContribution({
        sharedGoalId: destination.id,
        amountCents: cents,
        accountLabel: contributionAccount,
        date: contributionDate,
        ...(goal ? { localGoalId: goal.id } : {}),
      });
      setSavingContribution(false);
      if (!saved) return;
      setContribution("");
      setContributionFor("");
      setContributionAccount("");
      setContributionDate(format(new Date(), "yyyy-MM-dd"));
      return;
    }
    if (!goal) return;
    const transaction: FinanceTransaction = {
      id: crypto.randomUUID(),
      type: "transfer",
      subtype: "goal_contribution",
      amountCents: cents,
      category: `Meta • ${goal.name}`,
      account: contributionAccount,
      destinationAccount: `Meta • ${goal.name}`,
      description: `Contribuição • ${goal.name}`,
      date: dateAtLocalNoon(contributionDate),
      createdAt: new Date().toISOString(),
      goalId: goal.id,
    };
    saveTransactions([...transactions, transaction]);
    toast("Contribuição adicionada à meta.");
    setContribution("");
    setContributionFor("");
    setContributionAccount("");
    setContributionDate(format(new Date(), "yyyy-MM-dd"));
  };
  const share = async () => {
    if (!sharingGoal || !recipientId.trim()) return;
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return toast("Conecte o Supabase para compartilhar metas.");
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) return toast("Faça login novamente para compartilhar uma meta.");
    setSharing(true);
    try {
      let sharedGoalId = sharingGoal.sharedGoalId;
      if (!sharedGoalId) {
        const created = await supabase.rpc("create_shared_goal_with_initial_amount", {
          p_name: sharingGoal.name,
          p_target_cents: sharingGoal.targetCents,
          p_target_date: sharingGoal.targetDate || null,
          p_initial_cents: sharingGoal.currentCents,
        });
        if (created.error || !created.data) {
          toast("Não foi possível criar a meta compartilhada. Tente novamente.");
          return;
        }
        sharedGoalId = created.data;
        const linkedGoals = items.map((item: any) =>
          item.id === sharingGoal.id ? { ...item, sharedGoalId } : item,
        );
        save({ ...data, goals: linkedGoals });
        setSharingGoal({ ...sharingGoal, sharedGoalId });
      }
      const invitation = await supabase.rpc("invite_to_shared_goal", {
        p_goal_id: sharedGoalId,
        p_recipient_public_id: recipientId.trim(),
      });
      if (invitation.error) {
        toast(invitation.error.message || "ID Valurise não encontrado. A meta já ficou preparada; corrija o ID e tente novamente.");
        return;
      }
      setRecipientId("");
      setSharingGoal(null);
      toast("Convite de meta enviado. Ele aparecerá no sino e na área de Metas da outra conta.");
    } catch {
      toast("Não foi possível enviar o convite agora. A meta permanece salva para uma nova tentativa.");
    } finally {
      setSharing(false);
    }
  };
  return (
    <section className="mx-auto max-w-3xl px-4 pt-8">
      <SectionTitle
        title="Metas"
        help="Crie um objetivo com valor alvo e use “Adicionar dinheiro” para registrar cada contribuição e avançar a barra."
        onAdd={() => setAdding(true)}
        addLabel="Adicionar meta"
      />
      <p className="muted mt-2 text-sm">
        Acompanhe objetivos financeiros no seu ritmo.
      </p>
      {invites.length > 0 && <section className="panel mt-4 rounded-2xl p-4"><div className="flex items-center justify-between gap-3"><div><b className="text-sm">Convites de metas</b><p className="muted mt-1 text-xs">Responda aqui ou pelo sino de notificações.</p></div><span className="rounded-full bg-[var(--accent)]/15 px-2 py-1 text-xs font-semibold text-[var(--accent)]">{invites.length}</span></div><div className="mt-3 space-y-2">{invites.map((invite: SharedGoalInvite) => <div key={invite.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-[var(--panel2)] p-3"><span className="min-w-0 flex-1"><b className="block truncate text-sm">{invite.shared_goals?.name || "Meta compartilhada"}</b><small className="muted">Convite para acompanhar em conjunto</small></span><span className="flex shrink-0 gap-2"><button onClick={() => void respondInvite(invite.id, false)} className="muted min-h-10 rounded-lg px-3 text-xs">Recusar</button><button onClick={() => void respondInvite(invite.id, true)} className="primary min-h-10 rounded-lg px-3 text-xs font-medium">Aceitar</button></span></div>)}</div></section>}
      {items.length || receivedSharedGoals.length ? (
        <div className="mt-5 space-y-3">
          {items.map((item: any) => {
            const sharedGoal = (sharedGoals as SharedGoalSummary[]).find((goal) => goal.id === item.sharedGoalId);
            const currentCents = sharedGoal?.current_cents ?? item.currentCents;
            const targetCents = sharedGoal?.target_cents ?? item.targetCents;
            const goalName = sharedGoal?.name ?? item.name;
            const targetDate = sharedGoal?.target_date ?? item.targetDate;
            const percentage = targetCents > 0 ? Math.min(100, Math.round((currentCents / targetCents) * 100)) : 0;
            return (
              <article className="panel rounded-2xl p-4" key={item.id}>
                <div className="flex min-w-0 items-center justify-between gap-3">
                  <span className="min-w-0"><b className="block truncate">{goalName}</b>{sharedGoal && <small className="muted">Meta compartilhada</small>}</span>
                  <span className="shrink-0 text-sm">{percentage}%</span>
                </div>
                <div className="mt-3 h-2 overflow-hidden rounded-full bg-[var(--panel2)]">
                  <AnimatedProgress value={percentage} className="block h-full bg-[var(--accent)]" />
                </div>
                <p className="muted mt-2 text-sm">{formatBRL(currentCents)} de {formatBRL(targetCents)}</p>
                {targetDate && <p className="muted mt-1 text-xs">Para cumprir até {format(new Date(`${targetDate}T12:00:00`), "dd/MM/yyyy")}: {formatBRL(monthlyContributionNeeded(targetCents, currentCents, targetDate))}/mês</p>}
                {sharedGoal ? <SharedGoalStatement goal={sharedGoal} currentUserId={userId} /> : transactions.some((transaction: FinanceTransaction) => transaction.goalId === item.id) && (
                  <div className="mt-4 border-t border-[var(--border)] pt-3">
                    <p className="muted text-[11px] font-semibold uppercase tracking-wide">Contribuições recentes</p>
                    <div className="mt-2 space-y-2">
                      {transactions.filter((transaction: FinanceTransaction) => transaction.type === "transfer" && transaction.goalId === item.id).sort((a: FinanceTransaction, b: FinanceTransaction) => b.date.localeCompare(a.date)).slice(0, 3).map((transaction: FinanceTransaction) => <div className="flex items-center justify-between gap-3 text-xs" key={transaction.id}><span className="min-w-0 truncate muted">{format(new Date(transaction.date), "dd/MM/yyyy")} · {transaction.account}</span><b className="shrink-0">+{formatBRL(transaction.amountCents)}</b></div>)}
                    </div>
                  </div>
                )}
                <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2">
                  <button onClick={() => { setContributionFor(item.id); setContribution(""); setContributionAccount(""); setContributionDate(format(new Date(), "yyyy-MM-dd")); }} className="text-sm font-medium text-[var(--accent)]">+ Adicionar dinheiro</button>
                  {allowSharing && <button onClick={() => setSharingGoal({ ...item, currentCents })} className="text-sm font-medium text-[var(--accent)]">{item.sharedGoalId ? "Convidar pessoa" : "Compartilhar"}</button>}
                </div>
                {!item.sharedGoalId && <ItemActions label={`a meta ${item.name}`} onEdit={() => startEdit(item)} onDelete={() => setDeleting(item)} />}
              </article>
            );
          })}
          {receivedSharedGoals.map((goal: SharedGoalSummary) => {
            const percentage = goal.target_cents > 0 ? Math.min(100, Math.round((goal.current_cents / goal.target_cents) * 100)) : 0;
            return <article className="panel rounded-2xl p-4" key={goal.id}>
              <div className="flex min-w-0 items-center justify-between gap-3"><span className="min-w-0"><b className="block truncate">{goal.name}</b><small className="muted">Meta compartilhada</small></span><span className="shrink-0 text-sm">{percentage}%</span></div>
              <div className="mt-3 h-2 overflow-hidden rounded-full bg-[var(--panel2)]"><AnimatedProgress value={percentage} className="block h-full bg-[var(--accent)]" /></div>
              <p className="muted mt-2 text-sm">{formatBRL(goal.current_cents)} de {formatBRL(goal.target_cents)}</p>
              {goal.target_date && <p className="muted mt-1 text-xs">Prazo: {format(new Date(`${goal.target_date}T12:00:00`), "dd/MM/yyyy")}</p>}
              <SharedGoalStatement goal={goal} currentUserId={userId} />
              <button onClick={() => { setContributionFor(`shared:${goal.id}`); setContribution(""); setContributionAccount(""); setContributionDate(format(new Date(), "yyyy-MM-dd")); }} className="mt-3 text-sm font-medium text-[var(--accent)]">+ Adicionar dinheiro</button>
            </article>;
          })}
        </div>
      ) : (
        <Empty text="Nenhuma meta criada ou compartilhada com você." />
      )}
      {contributionFor && (
        <Sheet close={() => setContributionFor("")}>
          <section className="space-y-3">
            <b className="text-lg">Adicionar dinheiro à meta</b>
            <p className="muted text-sm">
              O valor será transferido da conta escolhida para a meta, sem ser tratado como gasto de consumo.
            </p>
            <input
              autoFocus
              aria-label="Valor da contribuição"
              value={contribution}
              onChange={(event) => setContribution(event.target.value)}
              inputMode="decimal"
              className="field"
              placeholder="Valor da contribuição"
            />
            <label className="block text-sm">
              Conta de origem
              <select className="field mt-1" value={contributionAccount} onChange={(event) => setContributionAccount(event.target.value)}>
                <option value="">Selecione a conta</option>
                {accounts.map((account: { value: string; label: string }) => <option key={account.value} value={account.value}>{account.label}</option>)}
              </select>
            </label>
            <label className="block text-sm">
              Data da contribuição
              <input className="field mt-1" type="date" max={format(new Date(), "yyyy-MM-dd")} value={contributionDate} onChange={(event) => setContributionDate(event.target.value)} />
            </label>
            {!accounts.length && <p className="muted rounded-xl bg-[var(--panel2)] p-3 text-xs">Cadastre uma conta antes de contribuir com esta meta.</p>}
            <button disabled={!accounts.length || savingContribution} onClick={() => void contribute()} className="primary h-11 w-full rounded-xl text-sm disabled:opacity-50">
              {savingContribution ? "Registrando…" : "Confirmar contribuição"}
            </button>
          </section>
        </Sheet>
      )}
      {(adding || editing) && (
        <Sheet close={() => { setAdding(false); setEditing(null); }}>
          <section className="space-y-3">
            <b className="text-lg">{editing ? "Editar meta" : "Criar meta"}</b>
            <input
              className="field"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Nome da meta"
            />
            <input
              className="field"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              inputMode="decimal"
              placeholder="Valor alvo"
            />
            <input
              className="field"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              inputMode="decimal"
              placeholder="Saldo já acumulado (opcional)"
            />
            <p className="muted -mt-1 text-xs leading-5">
              Informe apenas o saldo que já existia. Para guardar dinheiro agora e debitar uma conta, use “Adicionar dinheiro” depois de criar a meta.
            </p>
            <label className="block text-sm">
              Prazo (opcional)
              <input
                className="field mt-1"
                value={targetDate}
                onChange={(e) => setTargetDate(e.target.value)}
                type="date"
              />
            </label>
            <button
              onClick={persist}
              className="primary h-11 w-full rounded-xl text-sm"
            >
              {editing ? "Salvar alterações" : "Criar meta"}
            </button>
          </section>
        </Sheet>
      )}
      {allowSharing && sharingGoal && <Sheet close={() => setSharingGoal(null)}><section className="space-y-3"><b className="text-lg">Compartilhar meta</b><p className="muted text-sm leading-6">Convide outra pessoa pelo ID VALURISE. Ela só verá esta meta depois de aceitar o convite; seus demais dados continuam privados.</p><div className="rounded-xl bg-[var(--panel2)] p-3"><b className="text-sm">{sharingGoal.name}</b><p className="muted mt-1 text-xs">{formatBRL(sharingGoal.currentCents)} de {formatBRL(sharingGoal.targetCents)}</p></div><input autoFocus value={recipientId} onChange={(event) => setRecipientId(event.target.value)} className="field" placeholder="ID VALURISE da pessoa" autoCapitalize="characters"/><button disabled={sharing || !recipientId.trim()} onClick={() => void share()} className="primary h-11 w-full rounded-xl text-sm">{sharing ? "Enviando…" : "Enviar convite"}</button></section></Sheet>}
      {deleting && <DeleteConfirm title="Excluir meta?" description={`A meta “${deleting.name}” e o seu progresso individual serão removidos. Isso não apaga lançamentos da sua conta.`} close={() => setDeleting(null)} confirm={() => { save({ ...data, goals: items.filter((item: any) => item.id !== deleting.id) }); toast("Meta excluída."); setDeleting(null); }} />}
    </section>
  );
}
function SharedGoalStatement({ goal, currentUserId }: { goal: SharedGoalSummary; currentUserId: string }) {
  const contributions = goal.shared_goal_contributions || [];
  return <section className="mt-4 border-t border-[var(--border)] pt-3">
    <p className="muted text-[11px] font-semibold uppercase tracking-wide">Extrato da meta</p>
    <div className="mt-2 divide-y divide-[var(--border)]">
      {goal.initial_cents > 0 && <div className="flex items-center justify-between gap-3 py-2 text-xs"><span className="min-w-0"><b className="block">Saldo ao compartilhar</b><small className="muted">{format(new Date(goal.created_at), "dd/MM/yyyy")}</small></span><b className="shrink-0">{formatBRL(goal.initial_cents)}</b></div>}
      {contributions.slice(0, 5).map((contribution) => <div className="flex items-center justify-between gap-3 py-2 text-xs" key={contribution.id}><span className="min-w-0"><b className="block">{contribution.note === "Saldo ao compartilhar" ? "Saldo ao compartilhar" : contribution.user_id === currentUserId ? "Você contribuiu" : "Participante contribuiu"}</b><small className="muted">{format(new Date(contribution.contributed_at), "dd/MM/yyyy · HH:mm")}</small></span><b className="shrink-0 text-[var(--accent)]">+{formatBRL(contribution.amount_cents)}</b></div>)}
    </div>
    {!goal.initial_cents && !contributions.length && <p className="muted mt-2 text-xs">Nenhuma contribuição registrada ainda.</p>}
  </section>;
}
function Empty({ text }: any) {
  return <p className="muted mt-4 text-sm">{text}</p>;
}
function isCommitmentLateInMonth(bill: any, monthKey: string, today: Date) {
  const currentMonth = format(today, "yyyy-MM");
  const dueDay = recurringBillDueDay(bill, monthKey);
  return monthKey < currentMonth || (monthKey === currentMonth && dueDay < today.getDate());
}

function Planning({ data, tx, month, save, toast }: any) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<any | null>(null);
  const [deleting, setDeleting] = useState<any | null>(null);
  const [calendarMonth, setCalendarMonth] = useState(month);
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [dueDay, setDueDay] = useState("");
  const [category, setCategory] = useState("");
  const [frequency, setFrequency] = useState<"once" | "monthly" | "yearly">("monthly");
  const [startMonth, setStartMonth] = useState(format(month, "yyyy-MM"));
  const bills = data.recurringBills || [];
  const today = new Date();
  const currentMonth = format(calendarMonth, "yyyy-MM");
  const monthBills = bills
    .filter((bill: any) => isRecurringBillScheduledInMonth(bill, currentMonth))
    .map((bill: any) => ({ ...bill, occurrenceDay: recurringBillDueDay(bill, currentMonth) }))
    .sort((a: any, b: any) => a.occurrenceDay - b.occurrenceDay);
  const monthlyCommitted = monthBills.reduce((total: number, bill: any) => total + bill.amountCents, 0);
  const spent = tx
    .filter(
      (item: FinanceTransaction) =>
        item.type === "expense" && item.date.startsWith(currentMonth),
    )
    .reduce(
      (total: number, item: FinanceTransaction) => total + item.amountCents,
      0,
    );
  const projected = projectMonthEnd(
    spent,
    isSameMonth(calendarMonth, today) ? today.getDate() : new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 0).getDate(),
    new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 0).getDate(),
  );
  const paidCount = monthBills.filter((bill: any) => isRecurringBillPaidInMonth(bill, currentMonth)).length;
  const lateCount = monthBills.filter((bill: any) => !isRecurringBillPaidInMonth(bill, currentMonth) && (currentMonth < format(today, "yyyy-MM") || (currentMonth === format(today, "yyyy-MM") && bill.occurrenceDay < today.getDate()))).length;
  const pendingCount = monthBills.filter((bill: any) => !isRecurringBillPaidInMonth(bill, currentMonth) && !isCommitmentLateInMonth(bill, currentMonth, today)).length;
  const openNew = (monthKey = currentMonth, day?: number) => {
    setName(""); setAmount(""); setCategory(""); setFrequency("monthly"); setStartMonth(monthKey);
    setDueDay(day ? String(day) : ""); setAdding(true); setEditing(null);
  };
  const persist = () => {
    const amountCents = Math.round(Number(amount.replace(",", ".")) * 100);
    const due = Number(dueDay);
    if (!name.trim() || !amountCents || due < 1 || due > 31 || (frequency === "once" && !startMonth)) return;
    const schedule = { frequency, ...(startMonth ? { startMonth } : {}) };
    save({
      ...data,
      recurringBills: editing ? bills.map((bill: any) => bill.id === editing.id ? { ...bill, name: name.trim(), amountCents, dueDay: due, category: category.trim() || undefined, ...schedule } : bill) : [...bills, {
          id: crypto.randomUUID(),
          name: name.trim(),
          amountCents,
          dueDay: due,
          category: category.trim() || undefined,
          ...schedule,
          active: true,
        }],
    });
    toast(editing ? "Compromisso atualizado." : frequency === "once" ? "Compromisso adicionado ao calendário." : "Compromisso recorrente adicionado ao calendário.");
    setName("");
    setAmount("");
    setDueDay("");
    setCategory("");
    setFrequency("monthly");
    setStartMonth(currentMonth);
    setAdding(false);
    setEditing(null);
  };
  const startEdit = (bill: any) => { setEditing(bill); setName(bill.name); setAmount(centsInput(bill.amountCents)); setDueDay(String(bill.dueDay)); setCategory(bill.category || ""); setFrequency(bill.frequency || "monthly"); setStartMonth(bill.startMonth || ""); };
  return (
    <section className="mx-auto max-w-3xl px-4 pt-8">
      <SectionTitle
        title="Planejamento"
        help="Organize contas e pagamentos previstos. Defina se aparecem uma vez ou se repetem automaticamente nos próximos meses."
        onAdd={() => openNew()}
        addLabel="Adicionar compromisso"
      />
      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <section className="panel rounded-2xl p-5">
          <p className="muted text-xs">COMPROMISSOS DO PERÍODO</p>
          <b className="mt-2 block text-2xl">{formatBRL(monthlyCommitted)}</b>
          <p className="muted mt-2 text-sm">
            {monthBills.length} compromisso{monthBills.length === 1 ? "" : "s"} em {format(calendarMonth, "MMMM", { locale: ptBR })}
          </p>
        </section>
        <section className="panel rounded-2xl p-5">
          <p className="muted text-xs">PROJEÇÃO DE CONSUMO</p>
          <b className="mt-2 block text-2xl">{formatBRL(projected)}</b>
          <p className="muted mt-2 text-sm">
            No ritmo atual, até o fim deste mês.
          </p>
        </section>
      </div>
      <section className="panel mt-4 grid grid-cols-3 divide-x divide-[var(--border)] rounded-2xl p-4 text-center">
        <div>
          <b className="block text-lg text-[var(--accent)]">{paidCount}</b>
          <span className="muted text-[11px]">Pagas</span>
        </div>
        <div>
          <b className="block text-lg text-amber-400">{pendingCount}</b>
          <span className="muted text-[11px]">Pendentes</span>
        </div>
        <div>
          <b
            className={`block text-lg ${lateCount ? "text-[var(--danger)]" : "text-[var(--accent)]"}`}
          >
            {lateCount}
          </b>
          <span className="muted text-[11px]">Atrasadas</span>
        </div>
      </section>
      <FinancialCalendar
        month={calendarMonth}
        setMonth={setCalendarMonth}
        bills={bills}
        save={save}
        data={data}
        toast={toast}
        onAddForDate={openNew}
      />
      <section className="panel mt-4 rounded-2xl p-5">
        <div className="flex items-center justify-between">
          <b>Compromissos do período</b>
          <span className="muted text-xs">{format(calendarMonth, "MM/yyyy")}</span>
        </div>
        {monthBills.length ? (
          <div className="mt-3 divide-y divide-[var(--border)]">
            {monthBills.map((bill: any) => (
              <div
                key={bill.id}
                className="flex items-center justify-between py-3"
              >
                <span>
                  <b className="block text-sm">{bill.name}</b>
                  <small className="muted">
                    vence dia {bill.occurrenceDay} · {bill.frequency === "once" ? "uma vez" : bill.frequency === "yearly" ? "anual" : "mensal"}
                    {bill.category ? ` · ${bill.category}` : ""}
                  </small>
                </span>
                <span className="shrink-0 text-right"><b className="block text-sm">{formatBRL(bill.amountCents)}</b><ItemActions className="mt-1 justify-end" label={`a conta recorrente ${bill.name}`} onEdit={() => startEdit(bill)} onDelete={() => setDeleting(bill)} /></span>
              </div>
            ))}
          </div>
        ) : (
          <Empty text="Nenhum compromisso neste mês. Adicione aluguel, internet, água, luz ou assinaturas para planejar os próximos vencimentos." />
        )}
      </section>
      <CardInvoicePreview data={data} tx={tx} />
      <MonthlyReview data={data} save={save} />
      {(adding || editing) && (
        <Sheet close={() => { setAdding(false); setEditing(null); }}>
          <section className="space-y-3">
            <b className="text-lg">{editing ? "Editar conta recorrente" : "Nova conta recorrente"}</b>
            <input
              className="field"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ex.: Internet, aluguel, Netflix"
            />
            <input
              className="field"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
              placeholder="Valor previsto"
            />
            <input
              className="field"
              value={dueDay}
              onChange={(e) => setDueDay(e.target.value)}
              inputMode="numeric"
              placeholder="Dia de vencimento"
            />
            <label className="block space-y-1.5 text-sm">
              <span>Repetição</span>
              <select className="field" value={frequency} onChange={(event) => {
                const nextFrequency = event.target.value as "once" | "monthly" | "yearly";
                setFrequency(nextFrequency);
                if (!startMonth && nextFrequency !== "monthly") setStartMonth(currentMonth);
                if (!startMonth && nextFrequency === "monthly" && !editing) setStartMonth(currentMonth);
              }}>
                <option value="once">Uma vez</option>
                <option value="monthly">Todo mês</option>
                <option value="yearly">Todo ano</option>
              </select>
            </label>
            <label className="block space-y-1.5 text-sm">
              <span>{frequency === "once" ? "Mês do vencimento" : "Começar em"}</span>
              <input className="field" type="month" value={startMonth} onChange={(event) => setStartMonth(event.target.value)} />
            </label>
            <input
              className="field"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              placeholder="Categoria (opcional)"
              list="planning-categories"
            />
            <datalist id="planning-categories">
              {data.categories.map((item: string) => (
                <option value={item} key={item} />
              ))}
            </datalist>
            <button
              onClick={persist}
              className="primary h-11 w-full rounded-xl text-sm"
            >
              {editing ? "Salvar alterações" : "Adicionar ao planejamento"}
            </button>
            <p className="muted text-xs leading-5">A repetição cria lembretes nos meses seguintes; ela não registra uma despesa nem debita sua conta automaticamente. Registre o pagamento no extrato quando acontecer.</p>
          </section>
        </Sheet>
      )}
      {deleting && <DeleteConfirm title="Excluir conta recorrente?" description={`“${deleting.name}” deixará de ser considerado nos próximos vencimentos e compromissos.`} close={() => setDeleting(null)} confirm={() => { save({ ...data, recurringBills: bills.filter((bill: any) => bill.id !== deleting.id) }); toast("Conta recorrente excluída."); setDeleting(null); }} />}
    </section>
  );
}
function PlanningCheckRow({
  checked,
  onChange,
  label,
  description,
  marker,
  disabled = false,
  ariaLabel,
  className = "",
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  description?: string;
  marker?: number;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
}) {
  return (
    <label className={`group flex min-h-14 cursor-pointer items-center gap-3 rounded-xl p-3 text-left text-sm transition-colors ${checked ? "bg-[var(--accent)]/10" : "hover:bg-[var(--panel2)]"} ${disabled ? "cursor-not-allowed opacity-55" : ""} ${className}`}>
      <input
        type="checkbox"
        className="peer sr-only"
        checked={checked}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span
        aria-hidden="true"
        className={`grid h-8 w-8 shrink-0 place-items-center rounded-full text-xs font-semibold transition-colors peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[var(--accent)] ${checked ? "bg-[var(--accent)] text-[var(--accentfg)]" : marker !== undefined ? "bg-[var(--panel2)] text-[var(--muted)]" : "border border-[var(--border)] bg-[var(--panel2)] text-[var(--muted)]"}`}
      >
        {checked ? <Check size={16} /> : marker ?? null}
      </span>
      <span className="min-w-0 flex-1">
        <b className={`block text-sm ${checked ? "text-[var(--accent)]" : ""}`}>{label}</b>
        {description && <small className="muted mt-0.5 block leading-4">{description}</small>}
      </span>
      {checked && <span className="text-xs font-medium text-[var(--accent)]">Feito</span>}
    </label>
  );
}

function MonthlyReview({ data, save }: any) {
  const monthKey = format(new Date(), "yyyy-MM");
  const steps = [
    {
      id: "statement",
      title: "Conferir extrato",
      text: "Revise lançamentos e corrija o que não reconhece.",
    },
    {
      id: "budgets",
      title: "Revisar orçamentos",
      text: "Veja limites estourados ou que precisam de ajuste.",
    },
    {
      id: "goals",
      title: "Atualizar metas e aportes",
      text: "Registre contribuições e acompanhe seu avanço.",
    },
    {
      id: "next",
      title: "Planejar o próximo mês",
      text: "Confira vencimentos e deixe os compromissos organizados.",
    },
  ];
  const complete: string[] = data.monthlyReview?.[monthKey] || [];
  const toggle = (id: string) => {
    const next = complete.includes(id)
      ? complete.filter((item) => item !== id)
      : [...complete, id];
    save({
      ...data,
      monthlyReview: { ...(data.monthlyReview || {}), [monthKey]: next },
    });
  };
  const percentage = Math.round((complete.length / steps.length) * 100);
  return (
    <section className="panel mt-4 overflow-hidden rounded-2xl">
      <div className="border-b border-[var(--border)] p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="muted text-[10px] font-semibold tracking-[0.18em]">
              RITUAL DO MÊS
            </p>
            <b className="mt-1 block text-lg">Revisão mensal</b>
            <p className="muted mt-1 text-sm">
              Feche o mês com clareza em poucos minutos.
            </p>
          </div>
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-[var(--accent)]/15 text-sm font-semibold text-[var(--accent)]">
            {percentage}%
          </span>
        </div>
        <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-[var(--panel2)]">
          <AnimatedProgress
            value={percentage}
            className="block h-full rounded-full bg-[var(--accent)]"
          />
        </div>
      </div>
      <div className="p-3">
        {steps.map((step, index) => {
          const done = complete.includes(step.id);
          return (
            <PlanningCheckRow
              key={step.id}
              checked={done}
              onChange={() => toggle(step.id)}
              label={step.title}
              description={step.text}
              marker={index + 1}
            />
          );
        })}
      </div>
    </section>
  );
}
function FinancialCalendar({ month, setMonth, bills, save, data, toast, onAddForDate }: any) {
  const [selectedDay, setSelectedDay] = useState<number | null>(() => {
    const now = new Date();
    return format(month, "yyyy-MM") === format(now, "yyyy-MM") ? now.getDate() : null;
  });
  const key = format(month, "yyyy-MM");
  const today = new Date();
  const isCurrent = key === format(today, "yyyy-MM");
  const firstWeekday = (new Date(month.getFullYear(), month.getMonth(), 1).getDay() + 6) % 7;
  const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const cellCount = Math.ceil((firstWeekday + days) / 7) * 7;
  const cells = Array.from({ length: cellCount }, (_, index) => index - firstWeekday + 1);
  const monthBills = bills.filter((bill: any) => isRecurringBillScheduledInMonth(bill, key));
  const dayBills = (day: number) => monthBills.filter((bill: any) => recurringBillDueDay(bill, key) === day);
  const status = (bill: any) => isRecurringBillPaidInMonth(bill, key) ? "paid" : isCommitmentLateInMonth(bill, key, today) ? "late" : "pending";
  const total = monthBills.reduce((sum: number, bill: any) => sum + Number(bill.amountCents || 0), 0);
  const unpaid = monthBills.filter((bill: any) => !isRecurringBillPaidInMonth(bill, key)).reduce((sum: number, bill: any) => sum + Number(bill.amountCents || 0), 0);
  const selected = selectedDay === null ? [] : dayBills(selectedDay);
  const changeMonth = (offset: number) => {
    setMonth(startOfMonth(addMonths(month, offset)));
    setSelectedDay(null);
  };
  const togglePaid = (bill: any) => {
    const paid = !isRecurringBillPaidInMonth(bill, key);
    save({
      ...data,
      recurringBills: bills.map((item: any) => item.id === bill.id ? setRecurringBillPaidInMonth(item, key, paid) : item),
    });
    toast(paid ? `${bill.name} marcada como paga neste mês.` : `${bill.name} voltou para pendente neste mês.`);
  };
  return (
    <section className="panel mt-4 overflow-hidden rounded-2xl">
      <div className="border-b border-[var(--border)] p-4 sm:p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[var(--accent)]/12 text-[var(--accent)]"><CalendarDays size={18} /></span>
            <div className="min-w-0">
              <b className="block">Calendário financeiro</b>
              <p className="muted mt-1 text-xs">Vencimentos e pagamentos planejados</p>
            </div>
          </div>
          {!isCurrent && <button onClick={() => { setMonth(startOfMonth(today)); setSelectedDay(today.getDate()); }} className="min-h-10 shrink-0 rounded-xl px-3 text-xs font-medium text-[var(--accent)] hover:bg-[var(--panel2)]">Hoje</button>}
        </div>
        <div className="mt-4 flex items-center justify-between gap-2 rounded-xl bg-[var(--panel2)] p-2">
          <button aria-label="Mês anterior" onClick={() => changeMonth(-1)} className="grid h-10 w-10 shrink-0 place-items-center rounded-lg hover:bg-[var(--panel)]"><ChevronLeft size={18} /></button>
          <b className="min-w-0 truncate text-center text-sm capitalize">{format(month, "MMMM yyyy", { locale: ptBR })}</b>
          <button aria-label="Próximo mês" onClick={() => changeMonth(1)} className="grid h-10 w-10 shrink-0 place-items-center rounded-lg hover:bg-[var(--panel)]"><ChevronRight size={18} /></button>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          <span><b>{monthBills.length}</b><span className="muted"> compromisso{monthBills.length === 1 ? "" : "s"}</span></span>
          <span><b>{formatBRL(total)}</b><span className="muted"> previsto</span></span>
          <span><b className="text-amber-400">{formatBRL(unpaid)}</b><span className="muted"> em aberto</span></span>
        </div>
      </div>
      <div className="p-3 sm:p-5">
        <div className="grid grid-cols-7 text-center text-[10px] font-medium text-[var(--muted)] sm:text-xs">
          {["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"].map((day) => <span key={day} className="py-2">{day}</span>)}
        </div>
        <div className="grid grid-cols-7 gap-1 sm:gap-2">
          {cells.map((day, index) => {
            if (day < 1 || day > days) return <span key={`blank-${index}`} aria-hidden="true" className="min-h-[54px] sm:min-h-16" />;
            const items = dayBills(day);
            const statuses = items.map(status);
            const todayCell = isCurrent && day === today.getDate();
            const selectedCell = selectedDay === day;
            const label = `${format(new Date(month.getFullYear(), month.getMonth(), day), "d 'de' MMMM", { locale: ptBR })}${items.length ? `, ${items.length} vencimento${items.length === 1 ? "" : "s"}` : ", sem vencimentos"}`;
            return (
              <button
                key={day}
                aria-label={label}
                aria-pressed={selectedCell}
                onClick={() => setSelectedDay(day)}
                className={`relative flex min-h-[54px] flex-col items-center justify-center gap-1 rounded-xl border text-xs transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)] sm:min-h-16 ${selectedCell ? "border-[var(--accent)] bg-[var(--accent)]/10" : items.length ? "border-[var(--border)] bg-[var(--panel2)] hover:border-[var(--accent)]/60" : "border-transparent hover:bg-[var(--panel2)]"}`}
              >
                <span className={`grid h-7 w-7 place-items-center rounded-full font-medium ${todayCell ? "bg-[var(--accent)] text-[var(--accentfg)]" : ""}`}>{day}</span>
                {items.length > 0 && <span aria-hidden="true" className="flex h-1.5 items-center gap-0.5">{statuses.slice(0, 3).map((item: string, dotIndex: number) => <i key={dotIndex} className={`h-1.5 w-1.5 rounded-full ${item === "late" ? "bg-[var(--danger)]" : item === "paid" ? "bg-[var(--accent)]" : "bg-amber-400"}`} />)}</span>}
              </button>
            );
          })}
        </div>
        <div className="muted mt-3 flex flex-wrap gap-x-4 gap-y-2 text-[11px]">
          <span><i className="mr-1 inline-block h-2 w-2 rounded-full bg-amber-400" />Pendente</span>
          <span><i className="mr-1 inline-block h-2 w-2 rounded-full bg-[var(--danger)]" />Atrasada</span>
          <span><i className="mr-1 inline-block h-2 w-2 rounded-full bg-[var(--accent)]" />Paga</span>
        </div>
        {selectedDay !== null && (
          <div className="mt-4 border-t border-[var(--border)] pt-4">
            <div className="flex items-center justify-between gap-3">
              <div><b className="text-sm capitalize">{format(new Date(month.getFullYear(), month.getMonth(), selectedDay), "EEEE, d 'de' MMMM", { locale: ptBR })}</b><p className="muted mt-0.5 text-xs">{selected.length ? `${selected.length} compromisso${selected.length === 1 ? "" : "s"} neste dia` : "Dia livre no planejamento"}</p></div>
              <button onClick={() => onAddForDate?.(key, selectedDay)} className="flex min-h-10 shrink-0 items-center gap-1 rounded-xl px-3 text-xs font-medium text-[var(--accent)] hover:bg-[var(--panel2)]"><Plus size={15} />Adicionar</button>
            </div>
            {selected.length > 0 && <div className="mt-3 divide-y divide-[var(--border)] rounded-xl bg-[var(--panel2)] px-3">
              {selected.map((bill: any) => (
                <div key={bill.id} className="flex items-center justify-between gap-3 py-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl ${status(bill) === "paid" ? "bg-[var(--accent)]/15 text-[var(--accent)]" : status(bill) === "late" ? "bg-[var(--danger)]/10 text-[var(--danger)]" : "bg-[var(--panel)] text-amber-400"}`}><ReceiptText size={16} /></span>
                    <span className="min-w-0"><b className="block truncate text-sm">{bill.name}</b><small className="muted block truncate">{bill.category || "Sem categoria"} · {bill.frequency === "once" ? "uma vez" : bill.frequency === "yearly" ? "anual" : "mensal"} · {status(bill) === "paid" ? "Paga" : status(bill) === "late" ? "Atrasada" : "Pendente"}</small></span>
                  </div>
                  <div className="shrink-0 text-right"><b className="block text-sm">{formatBRL(bill.amountCents)}</b><button onClick={() => togglePaid(bill)} className={`mt-1 min-h-9 rounded-lg px-2 text-xs ${status(bill) === "paid" ? "text-[var(--muted)] hover:bg-[var(--panel)]" : "text-[var(--accent)] hover:bg-[var(--panel)]"}`}>{status(bill) === "paid" ? "Desfazer" : "Marcar paga"}</button></div>
                </div>
              ))}
            </div>}
            {!selected.length && <p className="muted mt-3 rounded-xl bg-[var(--panel2)] p-3 text-sm">Nenhum vencimento cadastrado para este dia. Use “Adicionar” para planejar uma conta ou pagamento.</p>}
          </div>
        )}
      </div>
    </section>
  );
}
function CardInvoicePreview({ data, tx }: any) {
  const cards = data.institutions.flatMap((institution: Institution) =>
    institution.cards.map((card) => ({ institution, card })),
  );
  const currentMonth = format(new Date(), "yyyy-MM");
  const nextMonth = format(addMonths(new Date(), 1), "yyyy-MM");
  if (!cards.length) return null;
  return (
    <section className="panel mt-4 rounded-2xl p-5">
      <div className="flex items-center justify-between">
        <b>Planejamento de faturas</b>
        <span className="muted text-xs">estimativa atual</span>
      </div>
      <div className="mt-3 divide-y divide-[var(--border)]">
        {cards.map(({ institution, card }: any) => {
          const label = `${institution.name} • ${card.name || "Crédito"}`;
          const current = tx
            .filter(
              (item: FinanceTransaction) =>
                item.type === "expense" &&
                item.account === label &&
                item.date.startsWith(currentMonth),
            )
            .reduce(
              (total: number, item: FinanceTransaction) =>
                total + item.amountCents,
              0,
            );
          const futureInstallments = tx
            .filter((item: FinanceTransaction) =>
              item.type === "expense" &&
              item.account === label &&
              Boolean(item.installmentGroupId) &&
              item.date.slice(0, 7) > currentMonth,
            )
            .reduce((total: number, item: FinanceTransaction) => total + item.amountCents, 0);
          const nextInvoice = tx
            .filter((item: FinanceTransaction) =>
              item.type === "expense" && item.account === label && item.date.startsWith(nextMonth),
            )
            .reduce((total: number, item: FinanceTransaction) => total + item.amountCents, 0);
          const committedLimit = current + futureInstallments;
          const available = Math.max(0, card.limit - committedLimit);
          return (
            <div className="py-3" key={card.id}>
              <div className="flex justify-between text-sm">
                <span>
                  {institution.name} · {card.name}
                </span>
                <b>{formatBRL(current)} / {formatBRL(card.limit)}</b>
              </div>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-[var(--panel2)]">
                <span
                  className="block h-full bg-[var(--accent)]"
                  style={{
                    width: `${card.limit > 0 ? Math.min(100, (committedLimit / card.limit) * 100) : 0}%`,
                  }}
                />
              </div>
              <p className="muted mt-2 text-xs">
                Comprometido: {formatBRL(committedLimit)} · disponível: {formatBRL(available)}
              </p>
              <p className="muted mt-1 text-xs">
                Próxima fatura: {formatBRL(nextInvoice)} · fecha dia {card.closingDay || "—"} · vence dia {card.dueDay || "—"}
              </p>
            </div>
          );
        })}
      </div>
    </section>
  );
}
function Reports({ tx, data, month }: any) {
  const current = tx.filter((item: FinanceTransaction) =>
    item.date.startsWith(format(month, "yyyy-MM")),
  );
  const summary = calculateSummary(current);
  const priorMonth = format(addMonths(month, -1), "yyyy-MM");
  const prior = calculateSummary(
    tx.filter((item: FinanceTransaction) => item.date.startsWith(priorMonth)),
  );
  const difference = summary.expenseCents - prior.expenseCents;
  const budgetTotal = (data.budgets || []).reduce(
    (n: number, item: any) => n + item.limitCents,
    0,
  );
  return (
    <section className="mx-auto max-w-3xl px-4 pt-8">
      <SectionTitle
        title="Relatórios"
        help="Comparativos objetivos, calculados a partir dos lançamentos registrados — sem IA e sem estimativas escondidas."
      />
      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <section className="panel rounded-2xl p-5">
          <p className="muted text-xs">RESULTADO DO MÊS</p>
          <b className="mt-2 block text-3xl">
            {formatBRL(summary.incomeCents - summary.expenseCents)}
          </b>
          <p className="muted mt-2 text-sm">
            Receitas menos consumo. Aportes ficam separados.
          </p>
        </section>
        <section className="panel rounded-2xl p-5">
          <p className="muted text-xs">COMPARAÇÃO DE CONSUMO</p>
          <b
            className={`mt-2 block text-3xl ${difference > 0 ? "text-[var(--danger)]" : "text-[var(--accent)]"}`}
          >
            {difference > 0 ? "+" : ""}
            {formatBRL(difference)}
          </b>
          <p className="muted mt-2 text-sm">Em relação ao mês anterior.</p>
        </section>
      </div>
      <section className="panel mt-4 rounded-2xl p-5">
        <b>Onde o dinheiro foi</b>
        {summary.topCategories.length ? (
          <div className="mt-4 space-y-4">
            {summary.topCategories.slice(0, 6).map((item: any) => {
              const share = summary.expenseCents
                ? Math.round((item.amountCents / summary.expenseCents) * 100)
                : 0;
              return (
                <div key={item.category}>
                  <div className="flex justify-between text-sm">
                    <span>{item.category}</span>
                    <span>
                      {formatBRL(item.amountCents)} · {share}%
                    </span>
                  </div>
                  <div className="mt-2 h-2 overflow-hidden rounded-full bg-[var(--panel2)]">
                    <span
                      className="block h-full rounded-full bg-[var(--accent)]"
                      style={{ width: `${share}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <Empty text="Registre movimentações para gerar seu relatório." />
        )}
      </section>
      <section className="panel mt-4 rounded-2xl p-5">
        <b>Planejado x realizado</b>
        <div className="mt-3 flex justify-between text-sm">
          <span className="muted">Orçamentos do mês</span>
          <b>{formatBRL(budgetTotal)}</b>
        </div>
        <div className="mt-2 flex justify-between text-sm">
          <span className="muted">Consumo registrado</span>
          <b>{formatBRL(summary.expenseCents)}</b>
        </div>
      </section>
    </section>
  );
}
type PersonalChatMessage = { id: string; role: "user" | "assistant"; content: string };
type PersonalChatProposal = {
  id: string;
  action_type: "income" | "expense";
  amount_cents: number;
  category: string;
  account_label: string;
  description: string;
  transaction_date: string;
  expires_at: string;
};
type PersonalChatError = Pick<PersonalAITestStatus, "message" | "category" | "providerMessage" | "providerCode" | "providerHttpStatus" | "requestId" | "model">;
function PersonalFinanceChat({ workspace, startMovement, approveAction, close }: { workspace: WorkspaceSummary; startMovement: (kind: Kind) => void; approveAction: (id: string) => Promise<void>; close: () => void }) {
  const [messages, setMessages] = useState<PersonalChatMessage[]>([
    { id: "welcome", role: "assistant", content: "Olá! Eu sou a Val, sua assistente financeira da Valurise. Vamos trazer clareza para suas decisões de hoje e constância para prosperar amanhã?" },
  ]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [input, setInput] = useState("");
  const [configured, setConfigured] = useState(false);
  const [connected, setConnected] = useState(false);
  const [provider, setProvider] = useState("");
  const [actionsEnabled, setActionsEnabled] = useState(false);
  const [proposals, setProposals] = useState<PersonalChatProposal[]>([]);
  const [decisionBusy, setDecisionBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<PersonalChatError | null>(null);
  const [lastUsage, setLastUsage] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const loadConnection = async () => {
      try {
        const supabase = getSupabaseBrowserClient();
        const { data } = await supabase?.auth.getSession() || {};
        if (!data?.session?.access_token) return;
        const headers = { Authorization: `Bearer ${data.session.access_token}`, "X-Valurise-Workspace-Id": workspace.id };
        const response = await fetch("/api/personal-ai/connection", { headers });
        const result = await response.json();
        if (cancelled) return;
        if (!response.ok) throw new Error(result.error || "Não foi possível verificar a conexão da IA.");
        if (result.connection) {
          setConfigured(true);
          setConnected(Boolean(result.connection.validated));
          setProvider(result.connection.provider);
          setActionsEnabled(Boolean(result.connection.actions_enabled));
          const historyResponse = await fetch("/api/personal-ai/chat", { headers });
          const history = await historyResponse.json();
          if (!historyResponse.ok) throw new Error(history.error || "Não foi possível carregar a conversa anterior.");
          if (!cancelled && Array.isArray(history.messages) && history.messages.length) {
            setMessages(history.messages.slice(-40));
          }
          const actionResponse = await fetch("/api/personal-ai/actions", { headers });
          const actionResult = await actionResponse.json();
          if (!actionResponse.ok) throw new Error(actionResult.error || "Não foi possível carregar propostas da Val.");
          if (!cancelled && Array.isArray(actionResult.proposals)) setProposals(actionResult.proposals);
        }
      } catch (reason) {
        if (!cancelled) setError({ message: reason instanceof Error ? reason.message : "Não foi possível conectar ao chat." });
      }
    };
    void loadConnection();
    return () => { cancelled = true; };
  }, [workspace.id]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, proposals, loading]);

  const send = async () => {
    const content = input.trim();
    if (!content || loading) return;
    const next = [...messages, { id: crypto.randomUUID(), role: "user" as const, content }];
    setMessages(next); setInput(""); setError(null);
    if (!connected) {
      setMessages([...next, { id: crypto.randomUUID(), role: "assistant", content: configured
        ? "Sua configuração está salva, mas ainda não foi validada. Acesse Configurações, teste a conexão e volte para conversar. Você pode continuar usando os atalhos para registrar movimentações."
        : "Sua IA pessoal ainda não está conectada. Para conversar sobre suas finanças, configure OpenAI, Gemini, DeepSeek, Groq ou OpenRouter em Configurações. Você pode continuar usando os atalhos para registrar movimentações." }]);
      return;
    }
    const supabase = getSupabaseBrowserClient();
    const { data } = await supabase?.auth.getSession() || {};
    if (!data?.session?.access_token) return setError({ message: "Sua sessão expirou. Entre novamente para conversar." });
    setLoading(true);
    try {
      const response = await fetch("/api/personal-ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${data.session.access_token}`, "X-Valurise-Workspace-Id": workspace.id },
        body: JSON.stringify({ messages: next.slice(-12).map(({ role, content: text }) => ({ role, content: text })) }),
      });
      const result = await response.json();
      if (!response.ok) {
        setError({ message: result.error || "Não foi possível responder agora.", category: result.category, providerMessage: result.providerMessage, providerCode: result.providerCode, providerHttpStatus: result.providerHttpStatus, requestId: result.requestId, model: result.model });
        return;
      }
      setLastUsage(typeof result.usage?.totalTokens === "number" ? result.usage.totalTokens : null);
      setMessages([...next, { id: crypto.randomUUID(), role: "assistant", content: result.reply }]);
      if (Array.isArray(result.proposals) && result.proposals.length) {
        setProposals((current) => [...result.proposals, ...current.filter((item) => !result.proposals.some((nextProposal: PersonalChatProposal) => nextProposal.id === item.id))].slice(0, 5));
      }
    } catch (reason) {
      setError({ message: reason instanceof Error ? reason.message : "Não foi possível responder agora." });
    } finally { setLoading(false); }
  };
  const decideProposal = async (proposalId: string, decision: "approve" | "reject") => {
    if (decisionBusy) return;
    setDecisionBusy(proposalId); setError(null);
    try {
      if (decision === "approve") {
        await approveAction(proposalId);
      } else {
        const supabase = getSupabaseBrowserClient();
        const { data } = await supabase?.auth.getSession() || {};
        const token = data?.session?.access_token;
        if (!token) throw new Error("Sua sessão expirou. Entre novamente para descartar.");
        const response = await fetch("/api/personal-ai/actions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "X-Valurise-Workspace-Id": workspace.id },
          body: JSON.stringify({ proposalId, decision }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Não foi possível descartar esta proposta.");
      }
      setProposals((current) => current.filter((proposal) => proposal.id !== proposalId));
      if (decision === "reject") setMessages((current) => [...current, { id: crypto.randomUUID(), role: "assistant", content: "Proposta descartada. Nenhum lançamento foi criado." }]);
    } catch (reason) {
      setError({ message: reason instanceof Error ? reason.message : "Não foi possível responder à proposta." });
      if (decision === "approve") {
        try {
          const supabase = getSupabaseBrowserClient();
          const { data } = await supabase?.auth.getSession() || {};
          const token = data?.session?.access_token;
          if (token) {
            const response = await fetch("/api/personal-ai/actions", { headers: { Authorization: `Bearer ${token}`, "X-Valurise-Workspace-Id": workspace.id } });
            const result = await response.json();
            if (response.ok && Array.isArray(result.proposals)) setProposals(result.proposals);
          }
        } catch { /* Keep the explicit error visible; no action is retried automatically. */ }
      }
    } finally { setDecisionBusy(null); }
  };
  return <section className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden">
    <div className="flex shrink-0 items-center gap-3 border-b border-[var(--border)] pb-4">
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[var(--accent)]/15 text-[var(--accent)]"><Bot size={20} /></span>
      <div className="min-w-0 flex-1"><b id="personal-finance-chat-title" className="block text-lg">Conversa com a Val</b><p className="muted mt-1 text-xs">{workspace.type === "business" ? `Contexto: empresa · ${workspace.displayName}` : `Contexto: pessoal · ${workspace.displayName}`} · {connected && provider ? `${AI_PROVIDER_METADATA[provider].label} validado.` : configured ? "Configuração salva · falta validar em Configurações." : "Clareza para decidir hoje. Constância para prosperar amanhã."}</p></div>
      <button type="button" onClick={close} aria-label="Voltar ao painel" className="flex min-h-10 shrink-0 items-center gap-1 rounded-xl px-2 text-xs font-medium text-[var(--accent)] hover:bg-[var(--panel2)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"><ChevronLeft size={18} /><span>Voltar</span></button>
    </div>
    <div aria-live="polite" className="mt-4 min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain pr-1">
      {messages.map((message) => <div key={message.id} className={`whitespace-pre-wrap break-words rounded-2xl px-4 py-3 text-sm leading-6 [overflow-wrap:anywhere] ${message.role === "user" ? "ml-auto max-w-[88%] primary rounded-br-md" : "w-full max-w-full bg-[var(--panel2)] rounded-bl-md"}`}>{message.role === "assistant" ? formatValResponse(message.content) : message.content}</div>)}
      {proposals.map((proposal) => <article key={proposal.id} className="w-full min-w-0 rounded-2xl border border-[var(--accent)]/35 bg-[var(--panel)] p-4 shadow-sm">
        <div className="flex items-start justify-between gap-3"><div className="min-w-0"><b className="block text-sm">Revisar proposta da Val</b><p className="muted mt-1 text-xs leading-5">Nada será registrado sem sua confirmação explícita.</p></div><span className="shrink-0 rounded-full bg-[var(--accent)]/10 px-2.5 py-1 text-[10px] font-semibold text-[var(--accent)]">Aguardando</span></div>
        <dl className="mt-3 grid min-w-0 grid-cols-2 gap-x-3 gap-y-2 rounded-xl bg-[var(--panel2)] p-3 text-xs"><div className="min-w-0"><dt className="muted">Tipo</dt><dd className="mt-0.5 font-medium">{proposal.action_type === "expense" ? "Despesa" : "Receita"}</dd></div><div className="min-w-0"><dt className="muted">Valor</dt><dd className="mt-0.5 break-words font-semibold">{formatBRL(proposal.amount_cents)}</dd></div><div className="min-w-0"><dt className="muted">Categoria</dt><dd className="mt-0.5 break-words">{proposal.category}</dd></div><div className="min-w-0"><dt className="muted">Data</dt><dd className="mt-0.5">{new Intl.DateTimeFormat("pt-BR").format(new Date(`${proposal.transaction_date}T12:00:00`))}</dd></div><div className="col-span-2 min-w-0"><dt className="muted">Conta</dt><dd className="mt-0.5 break-words">{proposal.account_label}</dd></div><div className="col-span-2 min-w-0"><dt className="muted">Descrição</dt><dd className="mt-0.5 break-words">{proposal.description}</dd></div></dl>
        <p className="muted mt-2 text-[10px] leading-4">A proposta expira em 10 minutos. Confira valor, conta e categoria antes de confirmar.</p>
        <div className="mt-3 flex flex-col-reverse gap-2 min-[380px]:flex-row min-[380px]:justify-end"><button type="button" disabled={decisionBusy === proposal.id} onClick={() => void decideProposal(proposal.id, "reject")} className="min-h-10 rounded-xl bg-[var(--panel2)] px-3 text-xs font-semibold disabled:opacity-50">{decisionBusy === proposal.id ? "Aguarde…" : "Descartar"}</button><button type="button" disabled={decisionBusy === proposal.id} onClick={() => void decideProposal(proposal.id, "approve")} className="primary min-h-10 rounded-xl px-3 text-xs font-semibold disabled:opacity-50">{decisionBusy === proposal.id ? "Confirmando…" : `Confirmar e registrar ${proposal.action_type === "expense" ? "despesa" : "receita"}`}</button></div>
      </article>)}
      {loading && <div className="w-fit rounded-2xl rounded-bl-md bg-[var(--panel2)] px-4 py-3 text-sm"><span className="inline-flex gap-1"><i className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--accent)]" /><i className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--accent)] [animation-delay:150ms]" /><i className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--accent)] [animation-delay:300ms]" /></span></div>}
      <div ref={messagesEndRef} />
    </div>
    {error && <div role="alert" className="mt-2 max-h-28 shrink-0 overflow-y-auto rounded-xl bg-[var(--panel2)] px-3 py-2 text-xs leading-5 text-[var(--danger)]">
      <p>{error.message}</p>
      {(error.category || error.model || error.providerHttpStatus || error.providerCode || error.requestId) && <p className="muted mt-1 break-words">{[
        error.category ? aiErrorCategoryLabels[error.category] || "Falha do provedor" : "",
        error.model ? `Modelo: ${error.model}` : "",
        error.providerHttpStatus ? `HTTP do provedor: ${error.providerHttpStatus}` : "",
        error.providerCode ? `Código: ${error.providerCode}` : "",
        error.requestId ? `Referência: ${error.requestId}` : "",
      ].filter(Boolean).join(" · ")}</p>}
      {error.providerMessage && <p className="muted mt-1 break-words">Detalhe do provedor: {error.providerMessage}</p>}
    </div>}
    <div role="group" aria-label="Atalhos de movimentação" className="mt-3 grid shrink-0 grid-cols-2 gap-2 pb-1 min-[350px]:grid-cols-3 sm:flex sm:flex-wrap sm:justify-start">
      {choices.map(([kind, label, Icon]) => <button key={label} type="button" onClick={() => startMovement(kind)} className="flex min-h-10 w-full min-w-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-full bg-[var(--panel2)] px-2 text-[11px] font-medium hover:ring-1 hover:ring-[var(--accent)] sm:w-auto sm:gap-2 sm:px-3 sm:text-xs"><Icon size={14} className="shrink-0 text-[var(--accent)]" />{label}</button>)}
    </div>
    <form className="mt-2 flex shrink-0 items-center gap-2 rounded-2xl border border-[var(--border)] bg-[var(--panel2)] p-2" onSubmit={(event) => { event.preventDefault(); void send(); }}>
      <input aria-label="Mensagem para a assistente financeira" value={input} onChange={(event) => setInput(event.target.value)} className="min-h-10 min-w-0 flex-1 bg-transparent px-2 py-2 text-sm outline-none placeholder:text-[var(--muted)]" placeholder={connected ? "Pergunte sobre suas finanças..." : configured ? "Valide a conexão em Configurações" : "Escreva uma dúvida"} />
      <button type="submit" disabled={!input.trim() || loading} aria-label="Enviar mensagem" className="primary grid h-10 w-10 shrink-0 place-items-center rounded-xl disabled:opacity-50"><SendHorizontal size={17} /></button>
    </form>
    <p className="muted mt-2 shrink-0 text-center text-[10px] leading-4">{connected ? `${actionsEnabled ? "Ações limitadas com sua aprovação obrigatória" : "Somente leitura"}${lastUsage === null ? " · O provedor não informou o consumo desta resposta." : ` · ${lastUsage.toLocaleString("pt-BR")} tokens nesta resposta.`}` : configured ? "A configuração foi salva, mas a Val só conversa depois que o teste do provedor passar. Os atalhos de movimentação continuam disponíveis." : "Sem IA? Use os atalhos para lançar. Conecte um provedor nas Configurações para conversar com a Val."}</p>
  </section>;
}
function Launcher({ data, workspace, close, saved, createCategory, createInvestment, approvePersonalAiAction }: any) {
  const [k, setK] = useState<Kind | null>(null),
    [step, setStep] = useState(0),
    [amount, setAmount] = useState(""),
    [cat, setCat] = useState(""),
    [source, setSource] = useState(""),
    [dest, setDest] = useState(""),
    [description, setDescription] = useState(""),
    [attachmentUrl, setAttachmentUrl] = useState(""),
    [tags, setTags] = useState<string[]>([]),
    [date, setDate] = useState(format(new Date(), "yyyy-MM-dd")),
    [newCat, setNewCat] = useState(""),
    [showCat, setShowCat] = useState(false),
    [investmentId, setInvestmentId] = useState(""),
    [newInvestment, setNewInvestment] = useState(""),
    [investmentClass, setInvestmentClass] = useState("Renda fixa"),
    [installmentCount, setInstallmentCount] = useState("1"),
    [showInvestment, setShowInvestment] = useState(false);
  const options = data.institutions.flatMap((i: Institution) => [
    ...i.accounts.map((a) => ({
      id: `account:${i.id}:${a.id}`,
      label: `${i.name} • ${a.name}`,
      kind: "account" as const,
    })),
    ...i.cards.map((c) => ({
      id: `card:${i.id}:${c.id}`,
      label: `${i.name} • ${c.name || "Crédito"}`,
      kind: "card" as const,
    })),
  ]);
  const selectedSource = options.find((option: { label: string }) => option.label === source);
  const sourceIsCard = selectedSource?.kind === "card";
  const categoryStep =
    k === "expense" || k === "income" || k === "investment" ? 1 : -1;
  const sourceStep = k === "transfer" || k === "salary" ? 1 : categoryStep + 1;
  const destinationStep = k === "transfer" ? sourceStep + 1 : -1;
  const detailsStep = (k === "transfer" ? destinationStep : sourceStep) + 1;
  const confirmStep = detailsStep + 1;
  const question =
    step === sourceStep
      ? k === "income"
        ? "Em qual conta você recebeu?"
          : k === "salary"
            ? "Em qual conta o salário entrou?"
            : k === "investment"
              ? "Qual conta financiou este aporte?"
              : k === "transfer"
                ? "De qual conta saiu?"
              : "Como você pagou?"
      : "Para qual conta foi?";
  const choose = (value: string) => {
    if (step === sourceStep) {
      setSource(value);
      if (options.find((option: { label: string }) => option.label === value)?.kind !== "card") setInstallmentCount("1");
    } else setDest(value);
  };
  const amountCents = Math.round(Number(amount.replace(",", ".")) * 100);
  const selectedInstallmentCount = Number(installmentCount);
  const valid = () => {
    if (step === 0) return Number.isSafeInteger(amountCents) && amountCents > 0;
    if (step === categoryStep) return Boolean(cat);
    if (step === sourceStep) return Boolean(source);
    if (step === destinationStep) return Boolean(dest) && dest !== source;
    if (step === detailsStep && k === "expense" && sourceIsCard && selectedInstallmentCount > 1) {
      return selectedInstallmentCount <= 48 && selectedInstallmentCount <= amountCents;
    }
    return true;
  };
  const final = () => {
    if (!k) return;
    const transaction: FinanceTransaction = {
        id: crypto.randomUUID(),
        type: k === "salary" ? "income" : k,
        subtype: k,
        amountCents,
        category: cat || labels(k),
        account: source,
        destinationAccount: dest || undefined,
        date: dateAtLocalNoon(date),
        description,
        attachmentUrl: attachmentUrl || undefined,
        tags,
        investmentId: k === "investment" ? investmentId : undefined,
        createdAt: new Date().toISOString(),
      };
    const count = k === "expense" && sourceIsCard ? selectedInstallmentCount : 1;
    saved(count > 1
      ? createInstallmentTransactions(transaction, count, crypto.randomUUID())
      : [transaction]);
  };
  const classifications =
    data.categories.length
        ? data.categories
        : defaults;
  if (!k)
    return (
      <ChatOverlay close={close}>
        <PersonalFinanceChat workspace={workspace} startMovement={(kind) => { setK(kind); setStep(0); }} approveAction={approvePersonalAiAction} close={close} />
      </ChatOverlay>
    );
  if (showCat)
    return (
      <Sheet close={() => setShowCat(false)}>
        <b>Nova categoria</b>
        <p className="muted mt-1 text-sm">
          Ela ficará selecionada neste lançamento.
        </p>
        <input
          autoFocus
          value={newCat}
          onChange={(e) => setNewCat(e.target.value)}
          className="field mt-5"
          placeholder="Nome da categoria"
        />
        <button
          onClick={() => {
            const name = newCat.trim();
            if (name) {
              createCategory(name);
              setCat(name);
              setShowCat(false);
              setNewCat("");
            }
          }}
          className="primary mt-3 h-11 w-full rounded-xl"
        >
          Criar e selecionar
        </button>
      </Sheet>
    );
  if (showInvestment)
    return (
      <Sheet close={() => setShowInvestment(false)}>
        <b className="text-lg">Novo investimento</b>
        <p className="muted mt-1 text-sm">
          Crie o ativo agora e este aporte já ficará vinculado a ele.
        </p>
        <input
          autoFocus
          value={newInvestment}
          onChange={(e) => setNewInvestment(e.target.value)}
          className="field mt-5"
          placeholder="Ex.: CDB liquidez diária"
        />
        <select
          value={investmentClass}
          onChange={(e) => setInvestmentClass(e.target.value)}
          className="field mt-3"
        >
          {[
            "Reserva de emergência",
            "Renda fixa",
            "CDB",
            "Tesouro",
            "Ações",
            "ETF",
            "Fundo",
            "Cripto",
            "Outros",
          ].map((item) => (
            <option key={item}>{item}</option>
          ))}
        </select>
        <button
          onClick={() => {
            const item = createInvestment(newInvestment, investmentClass);
            if (!item) return;
            setCat(item.name);
            setInvestmentId(item.id);
            setNewInvestment("");
            setShowInvestment(false);
          }}
          className="primary mt-3 h-11 w-full rounded-xl text-sm"
        >
          Criar e selecionar
        </button>
      </Sheet>
    );
  let body: React.ReactNode;
  if (step === 0)
    body = (
      <>
        <input
          autoFocus
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          inputMode="decimal"
          className="field mt-6 text-2xl"
          placeholder="R$ 0,00"
        />
        <p className="muted mt-2 text-xs">
          Digite apenas números, vírgula ou ponto.
        </p>
      </>
    );
  else if (step === categoryStep && k === "investment")
    body = (
      <div className="mt-5">
        {(data.investments || []).length ? (
          <div className="space-y-2">
            {(data.investments || []).map((item: any) => (
              <button
                onClick={() => {
                  setCat(item.name);
                  setInvestmentId(item.id);
                }}
                className={`block w-full rounded-xl bg-[var(--panel2)] p-3 text-left text-sm transition hover:ring-1 hover:ring-[var(--accent)] ${investmentId === item.id ? "ring-1 ring-[var(--accent)]" : ""}`}
                key={item.id}
              >
                <b className="block">{item.name}</b>
                <small className="muted">{item.assetClass || "Investimento"} · aportado {formatBRL(item.contributedCents)}</small>
              </button>
            ))}
          </div>
        ) : (
          <Empty text="Você ainda não tem investimentos cadastrados." />
        )}
        <button
          onClick={() => setShowInvestment(true)}
          className="mt-3 w-full rounded-xl border border-dashed border-[var(--accent)] px-3 py-3 text-sm font-medium text-[var(--accent)]"
        >
          + Criar investimento
        </button>
      </div>
    );
  else if (step === categoryStep)
    body = (
      <div className="mt-5 flex flex-wrap gap-2">
        {classifications.map((x: string) => (
          <button
            onClick={() => setCat(x)}
            className={`rounded-full px-3 py-2 text-sm ${cat === x ? "primary" : "bg-[var(--panel2)]"}`}
            key={x}
          >
            {x}
          </button>
        ))}
        <button
          onClick={() => setShowCat(true)}
          className="rounded-full border border-dashed border-[var(--accent)] px-3 py-2 text-sm text-[var(--accent)]"
        >
          + Criar
        </button>
      </div>
    );
  else if (step === sourceStep || step === destinationStep)
    body = (
      <div className="mt-5 space-y-2">
        {options.filter((option: { kind: string }) =>
          k === "expense" && step === sourceStep ? true : option.kind === "account",
        ).length ? (
          options.filter((option: { kind: string }) =>
            k === "expense" && step === sourceStep ? true : option.kind === "account",
          ).map((x: { id: string; label: string }) => (
            <button
              onClick={() => choose(x.label)}
              className={`block w-full rounded-xl bg-[var(--panel2)] p-3 text-left text-sm transition hover:ring-1 hover:ring-[var(--accent)] ${source === x.label || dest === x.label ? "ring-1 ring-[var(--accent)]" : ""}`}
              key={x.id}
            >
              {x.label}
            </button>
          ))
        ) : (
          <Empty text={k === "expense" && step === sourceStep ? "Cadastre uma conta ou cartão para continuar." : "Cadastre uma conta para continuar."} />
        )}
      </div>
    );
  else if (step === detailsStep)
    body = (
      <div className="mt-5 space-y-3">
        <label className="block text-sm">
          Data
          <input
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="field mt-1"
            type="date"
          />
        </label>
        {k === "expense" && sourceIsCard && (
          <label className="block text-sm">
            Parcelamento
            <select className="field mt-1" aria-label="Parcelamento da compra" value={installmentCount} onChange={(event) => setInstallmentCount(event.target.value)}>
              <option value="1">À vista</option>
              {[...Array.from({ length: 23 }, (_, index) => index + 2), 36, 48].map((count) => (
                <option value={count} key={count}>{count}x</option>
              ))}
            </select>
            {selectedInstallmentCount > 1 && (
              <small className="muted mt-1 block leading-5">
                Compra de {formatBRL(amountCents)} em {selectedInstallmentCount} parcelas; a diferença de centavos fica nas primeiras parcelas.
              </small>
            )}
          </label>
        )}
        <label className="block text-sm">
          Comprovante <span className="muted">(link opcional)</span>
          <input
            value={attachmentUrl}
            onChange={(e) => setAttachmentUrl(e.target.value)}
            className="field mt-1"
            type="url"
            placeholder="https://..."
          />
        </label>
        <label className="block text-sm">
          Descrição <span className="muted">(opcional)</span>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="field mt-1"
            placeholder="Ex.: abastecimento"
          />
        </label>
        {(data.tags || []).length > 0 && (
          <div>
            <p className="text-sm">
              Etiquetas <span className="muted">(opcional)</span>
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              {data.tags.map((item: string) => (
                <button
                  key={item}
                  onClick={() =>
                    setTags(
                      tags.includes(item)
                        ? tags.filter((value) => value !== item)
                        : [...tags, item],
                    )
                  }
                  className={`rounded-full px-3 py-1.5 text-xs ${tags.includes(item) ? "primary" : "bg-[var(--panel2)]"}`}
                >
                  #{item}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  else
    body = (
      <div className="mt-5 rounded-2xl bg-[var(--panel2)] p-4">
        <p className="text-sm">{labels(k)}</p>
        <b className="mt-1 block text-2xl">
          {formatBRL(amountCents)}
        </b>
        <p className="muted mt-3 text-sm">{cat || labels(k)}</p>
        <p className="muted text-sm">
          {source}
          {dest && ` → ${dest}`}
        </p>
        {k === "expense" && sourceIsCard && selectedInstallmentCount > 1 && (() => {
          const parts = splitInstallmentCents(amountCents, selectedInstallmentCount);
          return <p className="muted mt-2 text-sm">{selectedInstallmentCount} parcelas de {formatBRL(Math.min(...parts))} a {formatBRL(Math.max(...parts))}</p>;
        })()}
        {description && <p className="muted mt-2 text-sm">{description}</p>}
        {attachmentUrl && (
          <p className="mt-2 text-xs text-[var(--accent)]">
            Comprovante anexado
          </p>
        )}
        {tags.length > 0 && (
          <p className="mt-2 text-xs text-[var(--accent)]">
            {tags.map((item) => `#${item}`).join(" ")}
          </p>
        )}
      </div>
    );
  const heading =
    step === 0
      ? k === "salary"
        ? "Quanto você recebeu?"
        : "Quanto foi?"
      : step === categoryStep
        ? k === "investment"
          ? "Qual investimento é este?"
          : "Escolha uma categoria."
        : step === sourceStep || step === destinationStep
          ? question
          : step === detailsStep
            ? "Quando aconteceu?"
            : "Confirme o lançamento";
  return (
    <Sheet close={close}>
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="muted text-xs uppercase tracking-widest">{labels(k)}</p>
          <p className="mt-1 text-lg font-semibold">{heading}</p>
        </div>
        <span className="muted text-xs">
          {step + 1}/{confirmStep + 1}
        </span>
      </div>
      <div className="mt-4 h-1 overflow-hidden rounded-full bg-[var(--panel2)]">
        <span
          className="block h-full rounded-full bg-[var(--accent)] transition-all"
          style={{ width: `${((step + 1) / (confirmStep + 1)) * 100}%` }}
        />
      </div>
      {body}
      <div className="mt-6 flex gap-2">
        <button
          onClick={() => (step ? setStep(step - 1) : setK(null))}
          className="px-3 text-sm"
        >
          Voltar
        </button>
        <button
          disabled={!valid()}
          onClick={() => (step === confirmStep ? final() : setStep(step + 1))}
          className="primary flex-1 rounded-xl py-3 text-sm font-semibold disabled:opacity-40"
        >
          {step === confirmStep ? "Confirmar lançamento" : "Continuar"}
        </button>
      </div>
    </Sheet>
  );
}
function labels(k: Kind | null) {
  return k === "expense"
    ? "Gasto"
    : k === "income"
      ? "Recebimento"
      : k === "salary"
        ? "Salário"
        : k === "investment"
          ? "Aporte"
          : "Transferência";
}
function ChatOverlay({ children, close }: { children: ReactNode; close: () => void }) {
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [close]);

  return (
    <motion.div
      role="dialog"
      aria-modal="true"
      aria-labelledby="personal-finance-chat-title"
      className="fixed inset-0 z-40 h-[100dvh] overflow-hidden bg-[var(--panel)]"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: motionTokens.duration.normal }}
    >
      <motion.section
        className="h-full min-h-0 w-full overflow-hidden px-4 pt-[max(12px,env(safe-area-inset-top))] pb-[max(12px,env(safe-area-inset-bottom))] sm:px-6 lg:px-10"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 8 }}
        transition={{ duration: motionTokens.duration.normal, ease: motionTokens.ease.enter }}
      >
        {children}
      </motion.section>
    </motion.div>
  );
}

function Sheet({ children, close }: any) {
  return (
    <motion.div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-40 flex items-end bg-black/55 p-0 backdrop-blur-sm sm:items-center sm:justify-center sm:p-4"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: motionTokens.duration.normal }}
    >
      <motion.section
        className="max-h-[92dvh] w-full max-w-xl overflow-y-auto overscroll-contain rounded-t-3xl bg-[var(--panel)] p-5 pb-[max(20px,env(safe-area-inset-bottom))] shadow-2xl sm:rounded-3xl"
        initial={{ opacity: 0, y: 8, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: motionTokens.duration.normal, ease: motionTokens.ease.enter }}
      >
        <button
          aria-label="Fechar"
          onClick={close}
          className="float-right rounded-lg p-1 hover:bg-[var(--panel2)]"
        >
          <X />
        </button>
        {children}
      </motion.section>
    </motion.div>
  );
}
function Onboard({ user, finish }: any) {
  const [n, setN] = useState(""),
    [s, setS] = useState(""),
    [account, setAccount] = useState("");
  return (
    <main className="grid min-h-dvh place-items-center p-5">
      <section className="panel w-full max-w-md rounded-3xl p-6">
        <Brand />
        <h1 className="mt-8 text-2xl font-semibold">
          Tudo começa simples, {user.name}.
        </h1>
        <p className="muted mt-2 text-sm">
          Cadastre a primeira instituição ou pule para o dashboard.
        </p>
        <input
          className="field mt-6"
          value={n}
          onChange={(e) => setN(e.target.value)}
          placeholder="Nome da instituição"
        />
        <input
          className="field mt-3"
          value={account}
          onChange={(e) => setAccount(e.target.value)}
          placeholder="Nome da primeira conta (opcional)"
        />
        <input
          className="field mt-3"
          value={s}
          onChange={(e) => setS(e.target.value)}
          inputMode="decimal"
          placeholder="Saldo inicial (opcional)"
        />
        <button
          onClick={() =>
            finish({
              onboarded: true,
              categories: [],
              institutions: n
                ? [
                    {
                      id: crypto.randomUUID(),
                      name: n,
                      color: "#4edea3",
                      accounts: account.trim()
                        ? [
                            {
                              id: crypto.randomUUID(),
                              name: account.trim(),
                              balance:
                                Math.round(Number(s.replace(",", ".")) * 100) ||
                                0,
                            },
                          ]
                        : [],
                      cards: [],
                    },
                  ]
                : [],
            })
          }
          className="primary mt-5 h-12 w-full rounded-xl"
        >
          Ir para o Dashboard
        </button>
      </section>
    </main>
  );
}
function Institutions({ data, save, toast }: any) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<{ institution: Institution; account?: any } | null>(null);
  const [deleting, setDeleting] = useState<{ institution: Institution; account?: any } | null>(null);
  const [n, setN] = useState("");
  const [accountName, setAccountName] = useState("");
  const [targetInstitution, setTargetInstitution] = useState("");
  const [extraAccount, setExtraAccount] = useState("");
  const addAccount = () => {
    if (!targetInstitution || !extraAccount.trim()) return;
    const institutions = data.institutions.map((institution: Institution) =>
      institution.id === targetInstitution
        ? {
            ...institution,
            accounts: [
              ...institution.accounts,
              {
                id: crypto.randomUUID(),
                name: extraAccount.trim(),
                balance: 0,
              },
            ],
          }
        : institution,
    );
    save({ ...data, institutions });
    toast("Conta adicionada com sucesso.");
    setExtraAccount("");
    setAdding(false);
  };
  const saveEdit = () => {
    if (!editing || !n.trim()) return;
    const institutions = data.institutions.map((institution: Institution) => {
      if (institution.id !== editing.institution.id) return institution;
      if (!editing.account) return { ...institution, name: n.trim() };
      return { ...institution, accounts: institution.accounts.map((account: any) => account.id === editing.account.id ? { ...account, name: n.trim() } : account) };
    });
    save({ ...data, institutions }); toast(editing.account ? "Conta atualizada com sucesso." : "Instituição atualizada com sucesso."); setEditing(null); setN("");
  };
  return (
    <section className="mx-auto max-w-3xl px-4 pt-8">
      <SectionTitle
        title="Contas"
        help="Cadastre a instituição uma vez e inclua as contas dentro dela. Os saldos acompanham os lançamentos e transferências."
        onAdd={() => setAdding(true)}
        addLabel="Adicionar conta ou instituição"
      />
      <p className="muted mt-2 text-sm">
        Instituições agrupam suas contas e cartões.
      </p>
      {data.institutions.length ? (
        <div className="mt-6 space-y-3">
          {data.institutions.map((i: Institution) => (
            <div className="panel rounded-2xl p-4" key={i.id}>
              <div className="flex items-start justify-between gap-3"><b className="min-w-0 truncate">{i.name}</b><ItemActions className="mt-0 shrink-0" label={`a instituição ${i.name}`} onEdit={() => { setEditing({ institution: i }); setN(i.name); }} onDelete={() => setDeleting({ institution: i })} /></div>
              <p className="muted mt-1 text-sm">
                {i.accounts.map((x) => x.name).join(", ") || "Sem conta"}
              </p>
              {i.accounts.length > 0 && <div className="mt-3 divide-y divide-[var(--border)]">{i.accounts.map((account: any) => <div key={account.id} className="flex items-center justify-between gap-3 py-2"><span className="min-w-0"><b className="block truncate text-sm">{account.name}</b><small className="muted">Saldo inicial: {formatBRL(account.balance || 0)}</small></span><ItemActions className="mt-0 shrink-0" label={`a conta ${account.name}`} onEdit={() => { setEditing({ institution: i, account }); setN(account.name); }} onDelete={() => setDeleting({ institution: i, account })} /></div>)}</div>}
            </div>
          ))}
        </div>
      ) : (
        <Empty text="Você ainda não cadastrou nenhuma instituição." />
      )}
      {adding && (
        <Sheet close={() => setAdding(false)}>
          <section className="space-y-3">
            <b className="text-lg">Adicionar instituição</b>
            <p className="muted text-sm">
              Cadastre uma instituição uma vez. Depois você pode incluir uma ou
              mais contas nela.
            </p>
            <input
              className="field"
              value={n}
              onChange={(e) => setN(e.target.value)}
              placeholder="Nova instituição"
            />
            <input
              className="field"
              value={accountName}
              onChange={(e) => setAccountName(e.target.value)}
              placeholder="Nome da conta (opcional)"
            />
            <button
              onClick={() => {
                if (n) {
                  save({
                    ...data,
                    institutions: [
                      ...data.institutions,
                      {
                        id: crypto.randomUUID(),
                        name: n,
                        color: "#4edea3",
                        accounts: accountName.trim()
                          ? [
                              {
                                id: crypto.randomUUID(),
                                name: accountName.trim(),
                                balance: 0,
                              },
                            ]
                          : [],
                        cards: [],
                      },
                    ],
                  });
                  toast("Instituição criada com sucesso.");
                  setN("");
                  setAccountName("");
                  setAdding(false);
                }
              }}
              aria-label="Adicionar instituição"
              className="primary h-11 w-full rounded-xl text-sm"
            >
              Criar instituição
            </button>
            {data.institutions.length ? (
              <>
                <div className="border-t border-[var(--border)] pt-4" />
                <b className="text-sm">
                  Ou adicione uma conta a uma instituição
                </b>
                <select
                  value={targetInstitution}
                  onChange={(event) => setTargetInstitution(event.target.value)}
                  className="field"
                >
                  <option value="">Escolha a instituição</option>
                  {data.institutions.map((institution: Institution) => (
                    <option key={institution.id} value={institution.id}>
                      {institution.name}
                    </option>
                  ))}
                </select>
                <input
                  className="field"
                  value={extraAccount}
                  onChange={(event) => setExtraAccount(event.target.value)}
                  placeholder="Ex.: Conta digital, carteira"
                />
                <button
                  onClick={addAccount}
                  className="primary h-11 w-full rounded-xl text-sm"
                >
                  Adicionar conta
                </button>
              </>
            ) : null}
          </section>
        </Sheet>
      )}
      {editing && <Sheet close={() => { setEditing(null); setN(""); }}><section className="space-y-3"><b className="text-lg">Editar {editing.account ? "conta" : "instituição"}</b><input autoFocus className="field" value={n} onChange={(event) => setN(event.target.value)} placeholder={editing.account ? "Nome da conta" : "Nome da instituição"}/><button onClick={saveEdit} className="primary h-11 w-full rounded-xl text-sm">Salvar alterações</button></section></Sheet>}
      {deleting && <DeleteConfirm title={`Excluir ${deleting.account ? "conta" : "instituição"}?`} description={deleting.account ? `A conta “${deleting.account.name}” será removida. Confirme somente se não houver lançamentos que dependam dela.` : `A instituição “${deleting.institution.name}”, suas contas e cartões serão removidos da sua organização. Lançamentos históricos permanecem no extrato.`} close={() => setDeleting(null)} confirm={() => { const institutions = data.institutions.flatMap((institution: Institution) => { if (institution.id !== deleting.institution.id) return [institution]; if (!deleting.account) return []; return [{ ...institution, accounts: institution.accounts.filter((account: any) => account.id !== deleting.account.id) }]; }); save({ ...data, institutions }); toast(deleting.account ? "Conta excluída." : "Instituição excluída."); setDeleting(null); }} />}
    </section>
  );
}
function Cards({ data, save, toast }: any) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<{ institution: Institution; card: any } | null>(null);
  const [deleting, setDeleting] = useState<{ institution: Institution; card: any } | null>(null);
  const [institutionId, setInstitutionId] = useState("");
  const [nickname, setNickname] = useState("");
  const [limit, setLimit] = useState("");
  const [closingDay, setClosingDay] = useState("");
  const [dueDay, setDueDay] = useState("");

  const saveCard = () => {
    if (!institutionId || !Number(limit.replace(",", "."))) return;
    const institutions = data.institutions.map((institution: Institution) =>
      institution.id === institutionId
        ? {
            ...institution,
            cards: editing ? institution.cards.map((card: any) => card.id === editing.card.id ? {
                ...card,
                name: nickname.trim() || "Crédito",
                limit: Math.round(Number(limit.replace(",", ".")) * 100),
                closingDay: closingDay || undefined,
                dueDay: dueDay || undefined,
                bestPurchaseDay: bestPurchaseDay(closingDay)?.toString(),
              } : card) : [...institution.cards, { id: crypto.randomUUID(), name: nickname.trim() || "Crédito", limit: Math.round(Number(limit.replace(",", ".")) * 100), closingDay: closingDay || undefined, dueDay: dueDay || undefined, bestPurchaseDay: bestPurchaseDay(closingDay)?.toString() }],
          }
        : institution,
    );
    save({ ...data, institutions });
    toast(editing ? "Cartão atualizado com sucesso." : "Cartão criado com sucesso.");
    setNickname("");
    setLimit("");
    setClosingDay("");
    setDueDay("");
    setAdding(false);
    setEditing(null);
  };
  const startEdit = ({ institution, card }: { institution: Institution; card: any }) => { setEditing({ institution, card }); setInstitutionId(institution.id); setNickname(card.name); setLimit(centsInput(card.limit)); setClosingDay(card.closingDay || ""); setDueDay(card.dueDay || ""); setAdding(true); };

  const cards = data.institutions.flatMap((institution: Institution) =>
    institution.cards.map((card) => ({ institution, card })),
  );
  return (
    <section className="mx-auto max-w-3xl px-4 pt-8">
      <SectionTitle
        title="Cartões"
        help="Escolha uma instituição e crie o cartão dentro dela. O apelido evita nomes redundantes e facilita a escolha no lançamento."
        onAdd={() => setAdding(true)}
        addLabel="Adicionar cartão"
      />
      <p className="muted mt-2 text-sm">
        Um cartão sempre pertence a uma instituição. O apelido é opcional.
      </p>
      {cards.length ? (
        <div className="mt-5 space-y-3">
          {cards.map(({ institution, card }) => (
            <article className="panel rounded-2xl p-4" key={card.id}>
              <b>{institution.name}</b>
              <p className="muted mt-1 text-sm">
                {card.name} · crédito · limite {formatBRL(card.limit)}
              </p>
              {(card.closingDay || card.dueDay) && (
                <p className="muted mt-1 text-xs">
                  Fecha dia {card.closingDay || "—"} · vence dia{" "}
                  {card.dueDay || "—"}
                </p>
              )}
              {card.bestPurchaseDay && (
                <p className="mt-2 text-xs text-[var(--accent)]">
                  Melhor dia para comprar: dia {card.bestPurchaseDay}
                </p>
              )}
              <ItemActions label={`o cartão ${card.name}`} onEdit={() => startEdit({ institution, card })} onDelete={() => setDeleting({ institution, card })} />
            </article>
          ))}
        </div>
      ) : (
        <Empty text="Você ainda não possui cartões cadastrados." />
      )}
      {data.institutions.length && (adding || editing) ? (
        <Sheet close={() => { setAdding(false); setEditing(null); }}>
          <section className="space-y-3">
            <b className="text-sm">{editing ? "Editar cartão" : "Adicionar cartão"}</b>
            <select
              value={institutionId}
              onChange={(event) => setInstitutionId(event.target.value)}
              className="field"
            >
              <option value="">Escolha a instituição</option>
              {data.institutions.map((institution: Institution) => (
                <option value={institution.id} key={institution.id}>
                  {institution.name}
                </option>
              ))}
            </select>
            <input
              value={nickname}
              onChange={(event) => setNickname(event.target.value)}
              className="field"
              placeholder="Apelido, ex.: Platinum (opcional)"
            />
            <input
              value={limit}
              onChange={(event) => setLimit(event.target.value)}
              inputMode="decimal"
              className="field"
              placeholder="Limite"
            />
            <input
              value={closingDay}
              onChange={(event) => setClosingDay(event.target.value)}
              inputMode="numeric"
              className="field"
              placeholder="Dia de fechamento (opcional)"
            />
            <input
              value={dueDay}
              onChange={(event) => setDueDay(event.target.value)}
              inputMode="numeric"
              className="field"
              placeholder="Dia de vencimento (opcional)"
            />
            <button
              onClick={saveCard}
              className="primary h-11 w-full rounded-xl text-sm"
            >
              {editing ? "Salvar alterações" : "Adicionar cartão"}
            </button>
          </section>
        </Sheet>
      ) : (
        !data.institutions.length && (
          <p className="muted mt-5 text-sm">
            Cadastre primeiro uma instituição em Contas.
          </p>
        )
      )}
      {deleting && <DeleteConfirm title="Excluir cartão?" description={`O cartão “${deleting.card.name}” será removido de ${deleting.institution.name}. Compras já registradas no extrato não serão apagadas.`} close={() => setDeleting(null)} confirm={() => { save({ ...data, institutions: data.institutions.map((institution: Institution) => institution.id === deleting.institution.id ? { ...institution, cards: institution.cards.filter((card: any) => card.id !== deleting.card.id) } : institution) }); toast("Cartão excluído."); setDeleting(null); }} />}
    </section>
  );
}
function Categories({ data, tx, month, save, saveTx, toast }: any) {
  const [n, setN] = useState("");
  const [tag, setTag] = useState("");
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<{ kind: "category" | "tag"; value: string } | null>(null);
  const [deleting, setDeleting] = useState<{ kind: "category" | "tag"; value: string } | null>(null);
  const [editValue, setEditValue] = useState("");
  const applyEdit = () => {
    if (!editing || !editValue.trim()) return;
    const oldValue = editing.value, nextValue = editValue.trim();
    if (editing.kind === "category") { save({ ...data, categories: data.categories.map((item: string) => item === oldValue ? nextValue : item), budgets: (data.budgets || []).map((item: any) => item.category === oldValue ? { ...item, category: nextValue } : item) }); saveTx(tx.map((item: FinanceTransaction) => item.category === oldValue ? { ...item, category: nextValue } : item)); }
    else save({ ...data, tags: (data.tags || []).map((item: string) => item === oldValue ? nextValue : item) });
    toast(`${editing.kind === "category" ? "Categoria" : "Etiqueta"} atualizada com sucesso.`); setEditing(null); setEditValue("");
  };
  return (
    <section className="mx-auto max-w-3xl px-4 pt-8">
      <SectionTitle
        title="Categorias"
        help="Categorias organizam gastos e receitas. Você pode criar uma aqui ou durante um lançamento, sem interromper o fluxo."
        onAdd={() => setAdding(true)}
        addLabel="Adicionar categoria"
      />
      <CategorySpendingDonut tx={tx.filter((item: FinanceTransaction) => isSameMonth(new Date(item.date), month))} />
      <div className="mt-5 flex flex-wrap gap-2">
        {data.categories.map((x: string) => (
          <span
            className="rounded-full bg-[var(--panel2)] px-3 py-2 text-sm"
            key={x}
          >
            <span>{x}</span><button className="ml-2 text-[var(--accent)]" aria-label={`Editar categoria ${x}`} onClick={() => { setEditing({ kind: "category", value: x }); setEditValue(x); }}><Pencil size={12} /></button><button className="ml-1 text-[var(--danger)]" aria-label={`Excluir categoria ${x}`} onClick={() => setDeleting({ kind: "category", value: x })}><Trash2 size={12} /></button>
          </span>
        ))}
      </div>
      <section className="panel mt-5 rounded-2xl p-4">
        <div className="flex items-center justify-between">
          <b className="text-sm">Etiquetas</b>
          <span className="muted text-xs">filtros rápidos</span>
        </div>
        {(data.tags || []).length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {data.tags.map((item: string) => (
              <span
                key={item}
                className="rounded-full bg-[var(--panel2)] px-3 py-1.5 text-xs"
              >
                #{item}<button className="ml-2 text-[var(--accent)]" aria-label={`Editar etiqueta ${item}`} onClick={() => { setEditing({ kind: "tag", value: item }); setEditValue(item); }}><Pencil size={12} /></button><button className="ml-1 text-[var(--danger)]" aria-label={`Excluir etiqueta ${item}`} onClick={() => setDeleting({ kind: "tag", value: item })}><Trash2 size={12} /></button>
              </span>
            ))}
          </div>
        )}
        <div className="mt-3 flex gap-2">
          <input
            className="field"
            value={tag}
            onChange={(e) => setTag(e.target.value)}
            placeholder="Ex.: casa, trabalho, viagem"
          />
          <button
            onClick={() => {
              const clean = tag.trim();
              if (!clean) return;
              if (!(data.tags || []).includes(clean))
                save({ ...data, tags: [...(data.tags || []), clean] });
              setTag("");
              toast("Etiqueta criada com sucesso.");
            }}
            className="primary shrink-0 rounded-xl px-4 text-sm"
          >
            Adicionar
          </button>
        </div>
      </section>
      {adding && (
        <Sheet close={() => setAdding(false)}>
          <section className="space-y-3">
            <b className="text-lg">Nova categoria</b>
            <input
              className="field"
              value={n}
              onChange={(e) => setN(e.target.value)}
              placeholder="Nova categoria"
            />
            <button
              onClick={() => {
                if (n) {
                  save({ ...data, categories: [...data.categories, n] });
                  toast("Categoria criada com sucesso.");
                  setN("");
                  setAdding(false);
                }
              }}
              className="primary h-11 w-full rounded-xl"
            >
              <Plus />
            </button>
          </section>
        </Sheet>
      )}
      {editing && <Sheet close={() => setEditing(null)}><section className="space-y-3"><b className="text-lg">Editar {editing.kind === "category" ? "categoria" : "etiqueta"}</b><input autoFocus className="field" value={editValue} onChange={(event) => setEditValue(event.target.value)} /><button onClick={applyEdit} className="primary h-11 w-full rounded-xl text-sm">Salvar alterações</button></section></Sheet>}
      {deleting && <DeleteConfirm title={`Excluir ${deleting.kind === "category" ? "categoria" : "etiqueta"}?`} description={deleting.kind === "category" ? `A categoria “${deleting.value}” sairá da lista. Lançamentos anteriores continuarão no extrato com a classificação original.` : `A etiqueta “${deleting.value}” será removida da lista de etiquetas disponíveis.`} close={() => setDeleting(null)} confirm={() => { if (deleting.kind === "category") save({ ...data, categories: data.categories.filter((item: string) => item !== deleting.value), budgets: (data.budgets || []).filter((item: any) => item.category !== deleting.value) }); else save({ ...data, tags: (data.tags || []).filter((item: string) => item !== deleting.value) }); toast(`${deleting.kind === "category" ? "Categoria" : "Etiqueta"} excluída.`); setDeleting(null); }} />}
    </section>
  );
}
function CategorySpendingDonut({ tx }: { tx: FinanceTransaction[] }) {
  const palette = ["#4edea3", "#7c8cff", "#f7bd5c", "#f48ea7", "#50bce9", "#b993f2"];
  const items = Object.entries(
    tx
      .filter((item) => item.type === "expense")
      .reduce<Record<string, number>>((total, item) => {
        total[item.category] = (total[item.category] || 0) + item.amountCents;
        return total;
      }, {}),
  )
    .map(([name, amountCents]) => ({ name, amountCents }))
    .sort((a, b) => b.amountCents - a.amountCents);
  const total = items.reduce((sum, item) => sum + item.amountCents, 0);
  const visible = items.length > 5
    ? [
        ...items.slice(0, 5),
        {
          name: "Outras",
          amountCents: items.slice(5).reduce((sum, item) => sum + item.amountCents, 0),
        },
      ]
    : items;
  const circumference = 2 * Math.PI * 44;
  const segments = visible.map((item, index) => {
    const length = (item.amountCents / total) * circumference;
    const preceding = visible
      .slice(0, index)
      .reduce(
        (sum, previous) =>
          sum + (previous.amountCents / total) * circumference,
        0,
      );
    return { ...item, length, dashOffset: -preceding };
  });
  return (
    <section className="panel mt-5 overflow-hidden rounded-2xl p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <b className="text-lg">Gestão por categoria</b>
          <p className="muted mt-1 text-sm">Distribuição dos seus gastos</p>
        </div>
        <span className="rounded-full bg-[var(--accent)]/12 px-2.5 py-1 text-xs font-medium text-[var(--accent)]">
          despesas
        </span>
      </div>
      {total ? (
        <div className="mt-5 grid items-center gap-6 sm:grid-cols-[11rem_minmax(0,1fr)]">
          <div className="relative mx-auto grid h-44 w-44 place-items-center">
            <svg className="h-full w-full -rotate-90" viewBox="0 0 112 112" aria-label="Gráfico de pizza de gastos por categoria">
              <circle cx="56" cy="56" r="44" fill="none" stroke="var(--panel2)" strokeWidth="16" />
              {segments.map((item, index) => (
                  <motion.circle
                    key={item.name}
                    cx="56"
                    cy="56"
                    r="44"
                    fill="none"
                    stroke={palette[index % palette.length]}
                    strokeWidth="16"
                    strokeLinecap="butt"
                    initial={{ strokeDasharray: `0 ${circumference}` }}
                    animate={{ strokeDasharray: `${item.length} ${circumference}` }}
                    transition={{ duration: 0.7, delay: index * 0.06, ease: motionTokens.ease.enter }}
                    strokeDashoffset={item.dashOffset}
                  />
                ))}
            </svg>
            <div className="absolute text-center">
              <span className="muted block text-[11px]">Total gasto</span>
              <b className="mt-1 block text-sm">{formatBRL(total)}</b>
            </div>
          </div>
          <div className="min-w-0 divide-y divide-[var(--border)]">
            {visible.map((item, index) => {
              const percentage = Math.round((item.amountCents / total) * 100);
              return (
                <div className="flex min-w-0 items-center gap-3 py-2.5" key={item.name}>
                  <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: palette[index % palette.length] }} />
                  <span className="min-w-0 flex-1">
                    <b className="block truncate text-sm">{item.name}</b>
                    <small className="muted">{percentage}% dos gastos</small>
                  </span>
                  <b className="shrink-0 text-sm">{formatBRL(item.amountCents)}</b>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <Empty text="Registre despesas para visualizar a distribuição por categoria." />
      )}
    </section>
  );
}
function Statement({ tx, month, save, toast }: any) {
  const [query, setQuery] = useState("");
  const [type, setType] = useState("all");
  const [min, setMin] = useState("");
  const [max, setMax] = useState("");
  const [selected, setSelected] = useState<FinanceTransaction | null>(null);
  const [editing, setEditing] = useState<FinanceTransaction | null>(null);
  const [deleting, setDeleting] = useState<FinanceTransaction | null>(null);
  const [editDescription, setEditDescription] = useState("");
  const [editCategory, setEditCategory] = useState("");
  const [editAmount, setEditAmount] = useState("");
  const [scope, setScope] = useState<"month" | "all">("month");
  const visible = tx.filter((item: FinanceTransaction) => {
    const haystack =
      `${item.description || ""} ${item.category} ${item.account} ${(item.tags || []).join(" ")}`.toLocaleLowerCase(
        "pt-BR",
      );
    const amount = item.amountCents / 100;
    return (
      (scope === "all" || isSameMonth(new Date(item.date), month)) &&
      haystack.includes(query.toLocaleLowerCase("pt-BR")) &&
      (type === "all" || item.type === type) &&
      (!min || amount >= Number(min.replace(",", "."))) &&
      (!max || amount <= Number(max.replace(",", ".")))
    );
  });
  const grouped = visible.reduce(
    (
      groups: Record<string, FinanceTransaction[]>,
      transaction: FinanceTransaction,
    ) => {
      const key = format(new Date(transaction.date), "yyyy-MM-dd");
      (groups[key] ||= []).push(transaction);
      return groups;
    },
    {},
  );
  return (
    <section className="mx-auto max-w-3xl px-4 pt-8">
      <SectionTitle
        title="Extrato"
        help="Aqui ficam todas as movimentações registradas. Use-o para conferir o que entrou, saiu, foi investido ou transferido."
      />
      <input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        className="field mt-5"
        placeholder="Buscar por descrição, categoria, conta ou etiqueta"
      />
      <div className="mt-2 grid grid-cols-3 gap-2">
        <select
          className="field"
          value={type}
          onChange={(event) => setType(event.target.value)}
        >
          <option value="all">Todos</option>
          <option value="income">Receitas</option>
          <option value="expense">Despesas</option>
          <option value="investment">Aportes</option>
          <option value="transfer">Transferências</option>
        </select>
        <input
          className="field"
          value={min}
          onChange={(event) => setMin(event.target.value)}
          inputMode="decimal"
          placeholder="Valor mín."
        />
        <input
          className="field"
          value={max}
          onChange={(event) => setMax(event.target.value)}
          inputMode="decimal"
          placeholder="Valor máx."
        />
      </div>
      <div className="mt-3 flex gap-2">
        <button onClick={() => setScope("month")} className={`rounded-full px-3 py-1.5 text-xs ${scope === "month" ? "bg-[var(--accent)] text-[var(--accentfg)]" : "bg-[var(--panel2)]"}`}>
          {format(month, "MMMM yyyy", { locale: ptBR })}
        </button>
        <button onClick={() => setScope("all")} className={`rounded-full px-3 py-1.5 text-xs ${scope === "all" ? "bg-[var(--accent)] text-[var(--accentfg)]" : "bg-[var(--panel2)]"}`}>
          Todo histórico
        </button>
      </div>
      {visible.length ? (
        <div className="mt-5 space-y-6">
          {(Object.entries(grouped) as [string, FinanceTransaction[]][])
            .sort(([a], [b]) => b.localeCompare(a))
            .map(([date, items]) => (
              <section key={date}>
                <p className="muted mb-2 text-[11px] font-semibold tracking-widest">
                  {format(new Date(`${date}T12:00:00`), "dd MMMM", {
                    locale: ptBR,
                  }).toUpperCase()}
                </p>
                <div className="panel overflow-hidden rounded-2xl px-4">
                  <AnimatePresence initial={false}>
                  {items.map((x) => {
                    const positive = x.type === "income";
                    const transfer = x.type === "transfer";
                    const label = transfer
                      ? `${x.account} → ${x.destinationAccount}`
                      : x.account;
                    const typeLabel = transfer
                      ? "Transferência"
                      : x.type === "investment"
                        ? "Aporte"
                        : x.category;
                    return (
                      <motion.button
                        onClick={() => setSelected(x)}
                        layout
                        initial={{ opacity: 0, y: -6 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, height: 0 }}
                        transition={{ duration: motionTokens.duration.normal, ease: motionTokens.ease.enter }}
                        className="flex w-full items-center gap-3 border-b border-[var(--border)] py-4 text-left last:border-0 hover:bg-[var(--panel2)]"
                        key={x.id}
                      >
                        <span
                          className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${positive ? "bg-[var(--accent)]/15 text-[var(--accent)]" : "bg-[var(--panel2)]"}`}
                        >
                          {positive ? (
                            <ArrowDownLeft size={18} />
                          ) : transfer ? (
                            <WalletCards size={18} />
                          ) : x.type === "investment" ? (
                            <BarChart3 size={18} />
                          ) : (
                            <ArrowUpRight size={18} />
                          )}
                        </span>
                        <span className="min-w-0 flex-1">
                          <b className="block truncate text-sm">
                            {x.description || x.category}
                          </b>
                          <small className="muted mt-1 block truncate">
                            {typeLabel} · {label}
                          </small>
                          <small className="muted block">
                            {format(new Date(x.date), "HH:mm")}
                          </small>
                          {x.installment && (
                            <small className="muted mt-1 block">
                              Parcela {x.installment.current}/{x.installment.total}
                              {isFutureFinancialDay(x.date) ? " · Programada" : ""}
                            </small>
                          )}
                          {(x.tags || []).length > 0 && (
                            <small className="mt-1 block text-[var(--accent)]">
                              {x.tags!.map((tag) => `#${tag}`).join(" ")}
                            </small>
                          )}
                        </span>
                        <span
                          className={`shrink-0 text-sm font-semibold ${positive ? "text-[var(--accent)]" : ""}`}
                        >
                          {positive ? "+" : transfer ? "↔" : "-"}{" "}
                          {formatBRL(x.amountCents)}
                        </span>
                      </motion.button>
                    );
                  })}
                  </AnimatePresence>
                </div>
              </section>
            ))}
        </div>
      ) : (
        <Empty
          text={
            tx.length
              ? "Nenhum lançamento encontrado."
              : "Seu extrato está vazio."
          }
        />
      )}
      {selected && (
        <Sheet close={() => setSelected(null)}>
          <section className="space-y-4">
            <div>
              <p className="muted text-xs uppercase tracking-widest">
                {selected.type === "transfer"
                  ? "Transferência"
                  : selected.type === "investment"
                    ? "Aporte"
                    : selected.type === "income"
                      ? "Receita"
                      : "Despesa"}
              </p>
              <b className="mt-1 block text-3xl">
                {formatBRL(selected.amountCents)}
              </b>
            </div>
            <div className="rounded-2xl bg-[var(--panel2)] p-4 text-sm">
              <p>
                <span className="muted">Categoria: </span>
                {selected.category}
              </p>
              <p className="mt-2">
                <span className="muted">Conta: </span>
                {selected.account}
                {selected.destinationAccount
                  ? ` → ${selected.destinationAccount}`
                  : ""}
              </p>
              <p className="mt-2">
                <span className="muted">Data: </span>
                {format(new Date(selected.date), "dd/MM/yyyy 'às' HH:mm")}
              </p>
              {selected.installment && (
                <p className="mt-2">
                  <span className="muted">Parcela: </span>
                  {selected.installment.current}/{selected.installment.total}
                  {selected.installmentTotalCents
                    ? ` · compra de ${formatBRL(selected.installmentTotalCents)}`
                    : ""}
                  {isFutureFinancialDay(selected.date) ? " · programada" : ""}
                </p>
              )}
              {selected.description && (
                <p className="mt-2">
                  <span className="muted">Descrição: </span>
                  {selected.description}
                </p>
              )}
              {selected.attachmentUrl && (
                <a
                  className="mt-3 block text-[var(--accent)] underline"
                  href={selected.attachmentUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Abrir comprovante
                </a>
              )}
              {(selected.tags || []).length > 0 && (
                <p className="mt-2 text-[var(--accent)]">
                  {selected.tags!.map((tag) => `#${tag}`).join(" ")}
                </p>
              )}
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => { setEditing(selected); setEditDescription(selected.description || ""); setEditCategory(selected.category); setEditAmount(centsInput(selected.amountCents)); setSelected(null); }}
                className="rounded-xl bg-[var(--panel2)] px-4 py-3 text-sm"
              >
                Editar
              </button>
              <button
                onClick={() => {
                  const duplicate = {
                    ...selected,
                    id: crypto.randomUUID(),
                    date: new Date().toISOString(),
                    createdAt: new Date().toISOString(),
                  };
                  save([duplicate, ...tx]);
                  toast("Lançamento duplicado para hoje.");
                  setSelected(null);
                }}
                className="rounded-xl bg-[var(--panel2)] px-4 py-3 text-sm"
              >
                Duplicar
              </button>
              <button
                onClick={() => { setDeleting(selected); setSelected(null); }}
                className="rounded-xl px-4 py-3 text-sm text-[var(--danger)]"
              >
                Excluir
              </button>
            </div>
          </section>
        </Sheet>
      )}
      {editing && (
        <Sheet close={() => setEditing(null)}>
          <section className="space-y-3">
            <b className="text-lg">{editing.installment ? `Editar parcela ${editing.installment.current}/${editing.installment.total}` : "Editar lançamento"}</b>
            {editing.installment && <p className="muted text-sm">Somente esta parcela será alterada; as demais parcelas permanecem iguais.</p>}
            <input className="field" value={editDescription} onChange={(event) => setEditDescription(event.target.value)} placeholder="Descrição" />
            <input className="field" value={editCategory} onChange={(event) => setEditCategory(event.target.value)} placeholder="Categoria" />
            <input className="field" inputMode="decimal" value={editAmount} onChange={(event) => setEditAmount(event.target.value)} placeholder="Valor" />
            <button
              onClick={() => {
                const amountCents = Math.round(Number(editAmount.replace(",", ".")) * 100);
                if (!Number.isSafeInteger(amountCents) || amountCents <= 0 || !editCategory.trim()) return;
                let next = tx.map((item: FinanceTransaction) => item.id === editing.id
                  ? { ...item, description: editDescription.trim() || undefined, category: editCategory.trim(), amountCents }
                  : item);
                if (editing.installmentGroupId) {
                  const groupTotal = next
                    .filter((item: FinanceTransaction) => item.installmentGroupId === editing.installmentGroupId)
                    .reduce((total: number, item: FinanceTransaction) => total + item.amountCents, 0);
                  next = next.map((item: FinanceTransaction) => item.installmentGroupId === editing.installmentGroupId
                    ? { ...item, installmentTotalCents: groupTotal }
                    : item);
                }
                save(next);
                toast("Lançamento atualizado com sucesso.");
                setEditing(null);
              }}
              className="primary h-11 w-full rounded-xl text-sm"
            >Salvar alterações</button>
          </section>
        </Sheet>
      )}
      {deleting && (
        <DeleteConfirm
          title={deleting.installment ? `Excluir parcela ${deleting.installment.current}/${deleting.installment.total}?` : "Excluir lançamento?"}
          description={deleting.installment ? `Somente esta parcela de ${formatBRL(deleting.amountCents)} será removida; as demais parcelas continuam no extrato.` : `O lançamento de ${formatBRL(deleting.amountCents)} será removido. Os totais, orçamentos e o dashboard serão recalculados.`}
          close={() => setDeleting(null)}
          confirm={() => {
            let next = tx.filter((item: FinanceTransaction) => item.id !== deleting.id);
            if (deleting.installmentGroupId) {
              const groupTotal = next
                .filter((item: FinanceTransaction) => item.installmentGroupId === deleting.installmentGroupId)
                .reduce((total: number, item: FinanceTransaction) => total + item.amountCents, 0);
              next = next.map((item: FinanceTransaction) => item.installmentGroupId === deleting.installmentGroupId
                ? { ...item, installmentTotalCents: groupTotal }
                : item);
            }
            save(next);
            toast("Lançamento excluído.");
            setDeleting(null);
          }}
        />
      )}
    </section>
  );
}
function Settings({ theme, setTheme, data, tx, saveData, saveTx, restoreFinancialBackup, toast, logout, localStoragePrefix, workspaceId, businessWorkspace }: any) {
  const syncEnabled = Boolean(getSupabaseBrowserClient());
  const [restoreCandidate, setRestoreCandidate] = useState<any | null>(null);
  const [backupError, setBackupError] = useState("");
  const exportBackup = () => {
    const blob = new Blob(
      [
        JSON.stringify(
          createValuriseBackup(data, tx),
          null,
          2,
        ),
      ],
      { type: "application/json" },
    );
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `valurise-backup-${format(new Date(), "yyyy-MM-dd")}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };
  const inspectBackup = async (file?: File) => {
    setBackupError("");
    if (!file) return;
    try {
      const backup = parseValuriseBackup<any, FinanceTransaction>(await file.text());
      setRestoreCandidate(backup);
    } catch (error) {
      setBackupError(error instanceof Error ? error.message : "Não foi possível ler este backup.");
    }
  };
  const importCsv = async (file?: File) => {
    if (!file) return;
    const rows = (await file.text()).split(/\r?\n/).filter(Boolean);
    const headers =
      rows
        .shift()
        ?.split(";")
        .map((item) => item.trim().toLowerCase()) || [];
    const dateIndex = headers.findIndex((item) => /data|date/.test(item));
    const valueIndex = headers.findIndex((item) => /valor|value/.test(item));
    const descriptionIndex = headers.findIndex((item) =>
      /descri|description|nome/.test(item),
    );
    if (dateIndex < 0 || valueIndex < 0) {
      toast("CSV precisa ter as colunas data e valor.");
      return;
    }
    const imported = rows.flatMap((row) => {
      const columns = row.split(";");
      const raw = (columns[valueIndex] || "")
        .replace(/[^0-9,-]/g, "")
        .replace(".", "")
        .replace(",", ".");
      const value = Number(raw);
      if (!value || !columns[dateIndex]) return [];
      const iso = /^\d{2}\/\d{2}\/\d{4}$/.test(columns[dateIndex])
        ? columns[dateIndex].split("/").reverse().join("-")
        : columns[dateIndex];
      return [
        {
          id: crypto.randomUUID(),
          type: value > 0 ? "income" : "expense",
          amountCents: Math.round(Math.abs(value) * 100),
          category: "Importado",
          account: "Importação",
          date: new Date(`${iso}T12:00:00`).toISOString(),
          createdAt: new Date().toISOString(),
          description: columns[descriptionIndex] || "Lançamento importado",
        } as FinanceTransaction,
      ];
    });
    saveTx([...imported, ...tx]);
    toast(`${imported.length} lançamento(s) importado(s).`);
  };
  return (
    <section className="mx-auto max-w-3xl px-4 pt-8">
      <SectionTitle
        title="Configurações"
        help="Ajuste a aparência da aplicação e, nas próximas versões, suas preferências financeiras e dados de conta."
      />
      {businessWorkspace && <BusinessFinanceSettings workspaceId={workspaceId} toast={toast} />}
      <Theme value={theme} change={setTheme} />
      <section className="panel mt-6 rounded-2xl p-5">
        <b>Seus dados</b>
        <p className="muted mt-1 text-sm leading-6">
          Baixe uma cópia dos dados financeiros desta conta e restaure-a quando precisar. A restauração substitui os dados financeiros atuais; conta, acesso e preferências não são alterados.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            onClick={exportBackup}
            className="min-h-11 rounded-xl bg-[var(--panel2)] px-4 py-3 text-sm"
          >
            Exportar backup JSON
          </button>
          <label className="primary inline-flex min-h-11 cursor-pointer items-center rounded-xl px-4 py-3 text-sm">
            Restaurar backup JSON
            <input
              type="file"
              accept=".json,application/json"
              className="sr-only"
              onChange={(event) => {
                void inspectBackup(event.target.files?.[0]);
                event.currentTarget.value = "";
              }}
            />
          </label>
          <label className="inline-flex min-h-11 cursor-pointer items-center rounded-xl bg-[var(--panel2)] px-4 py-3 text-sm">
            Importar CSV
            <input
              onChange={(event) => importCsv(event.target.files?.[0])}
              className="sr-only"
              type="file"
              accept=".csv,text/csv"
            />
          </label>
        </div>
        {backupError && <p role="alert" className="mt-3 text-sm text-[var(--danger)]">{backupError}</p>}
      </section>
      <section className="panel mt-4 rounded-2xl p-5">
        <b>Privacidade</b>
        <p className="muted mt-1 text-sm">
          {syncEnabled
            ? "A sincronização segura está disponível para sessões autenticadas pelo Supabase."
            : "A sincronização entre dispositivos será ativada ao configurar as credenciais do Supabase. Até lá, use o backup JSON antes de trocar de dispositivo."}
        </p>
        <LegalPreferences toast={toast} />
      </section>
      <AccountDeletion logout={logout} localStoragePrefix={localStoragePrefix} />
      <PersonalAISettings toast={toast} workspaceId={workspaceId} />
      {restoreCandidate && <Sheet close={() => setRestoreCandidate(null)}><section className="space-y-4"><div><b className="text-lg">Restaurar backup?</b><p className="muted mt-2 text-sm leading-6">Isso substituirá contas, cartões, categorias, metas, orçamentos, investimentos e lançamentos atuais pelos dados do arquivo. Essa ação não pode ser desfeita dentro do app. Exporte o estado atual antes se quiser preservá-lo.</p><p className="muted mt-2 text-xs">{restoreCandidate.transactions.length} lançamento(s) no arquivo{restoreCandidate.exportedAt ? ` · exportado em ${format(new Date(restoreCandidate.exportedAt), "dd/MM/yyyy 'às' HH:mm")}` : " · formato legado"}</p></div><div className="flex gap-2"><button onClick={() => setRestoreCandidate(null)} className="h-11 flex-1 rounded-xl bg-[var(--panel2)] text-sm font-medium">Cancelar</button><button onClick={() => { restoreFinancialBackup(restoreCandidate.data, restoreCandidate.transactions); setRestoreCandidate(null); toast("Backup restaurado e sincronização iniciada."); }} className="primary h-11 flex-1 rounded-xl text-sm font-semibold">Restaurar dados</button></div></section></Sheet>}
    </section>
  );
}
function AccountDeletion({ logout, localStoragePrefix }: { logout: () => void; localStoragePrefix: string }) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async () => {
    if (!password || confirmation !== "EXCLUIR") return setError("Digite sua senha e a palavra EXCLUIR para continuar.");
    const supabase = getSupabaseBrowserClient();
    const { data } = await supabase?.auth.getSession() || {};
    const token = data?.session?.access_token;
    if (!token) return setError("Sua sessão expirou. Entre novamente e repita a solicitação.");
    setBusy(true); setError("");
    const response = await fetch("/api/account/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ password, confirmation }),
    });
    const result = await response.json();
    setBusy(false);
    if (!response.ok) return setError(result.error || "Não foi possível mover a conta para a lixeira.");
    [":data", ":tx", ":profile", ":theme"].forEach((suffix) => localStorage.removeItem(localStoragePrefix + suffix));
    await supabase?.auth.signOut();
    logout();
    window.location.reload();
  };
  return <section className="panel mt-4 rounded-2xl p-5"><b>Remover minha conta</b><p className="muted mt-1 text-sm leading-6">Sua conta será desativada e movida para a lixeira. Os dados não serão apagados agora; o Master poderá restaurar ou excluir definitivamente a conta depois. Exporte um backup se quiser guardar uma cópia.</p><button onClick={() => { setError(""); setOpen(true); }} className="mt-4 min-h-11 rounded-xl border border-[var(--danger)]/40 px-4 text-sm text-[var(--danger)]">Solicitar remoção</button>{open && <Sheet close={() => { if (!busy) setOpen(false); }}><section className="space-y-4"><div><b className="text-lg">Mover conta para a lixeira?</b><p className="muted mt-2 text-sm leading-6">Você perderá o acesso imediatamente. Os dados serão mantidos até que o Master decida restaurar ou excluir a conta definitivamente.</p></div><label className="block text-sm">Confirme sua senha<input autoComplete="current-password" type="password" className="field mt-2" value={password} onChange={(event) => setPassword(event.target.value)} /></label><label className="block text-sm">Digite EXCLUIR para confirmar<input className="field mt-2" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></label>{error && <p role="alert" className="text-sm text-[var(--danger)]">{error}</p>}<button disabled={busy || !password || confirmation !== "EXCLUIR"} onClick={() => void submit()} className="min-h-11 w-full rounded-xl bg-[var(--danger)] px-4 text-sm font-semibold text-[#271313] disabled:opacity-50">{busy ? "Removendo…" : "Mover para a lixeira"}</button></section></Sheet>}</section>;
}
type PersonalAIProvider = AIProvider;
type PersonalAIModelOption = AIModelOption;
type PersonalAIUsage = { requests: number; totalTokens: number; inputTokens: number; outputTokens: number; quotaTokens: number | null };
type PersonalAITestStatus = { ok: boolean; message: string; category?: string; providerMessage?: string | null; providerCode?: string | null; providerHttpStatus?: number | null; requestId?: string | null; model?: string; toolCallingValidated?: boolean };
const aiErrorCategoryLabels: Record<string, string> = {
  INVALID_API_KEY: "Chave inválida",
  INVALID_MODEL: "Modelo inválido ou não habilitado",
  MODEL_UNAVAILABLE: "Modelo indisponível para esta conta",
  INVALID_REQUEST: "Solicitação rejeitada pelo provedor",
  PERMISSION_DENIED: "Permissão negada",
  BILLING_REQUIRED: "Pré-condição de faturamento",
  INSUFFICIENT_BALANCE: "Saldo insuficiente",
  RATE_LIMITED: "Limite de requisições",
  QUOTA_EXCEEDED: "Cota do provedor",
  PROVIDER_OVERLOADED: "Provedor sobrecarregado",
  PROVIDER_UNAVAILABLE: "Provedor indisponível",
  APP_RATE_LIMITED: "Limite de testes do Valurise",
  REGION_RESTRICTED: "Modelo indisponível nesta região",
  CONTENT_BLOCKED: "Resposta bloqueada pelo provedor",
  TIMEOUT: "Tempo limite da conexão",
  NETWORK_ERROR: "Falha de rede",
  MALFORMED_RESPONSE: "Resposta inválida do provedor",
  TOOL_CALL_ERROR: "Falha ao consultar uma ferramenta",
  TOOL_CALL_UNSUPPORTED: "Este modelo não oferece as ferramentas da Val",
  UNKNOWN_PROVIDER_ERROR: "Erro retornado pelo provedor",
};
const defaultAIModel: Record<PersonalAIProvider, string> = Object.fromEntries(
  AI_PROVIDERS.map((item) => [item, AI_PROVIDER_METADATA[item].defaultModel]),
) as Record<PersonalAIProvider, string>;
function PersonalAISettings({ toast, workspaceId }: { toast: (text: string) => void; workspaceId: string }) {
  const [provider, setProvider] = useState<PersonalAIProvider>("openai");
  const [savedProvider, setSavedProvider] = useState<PersonalAIProvider | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(defaultAIModel.openai);
  const [models, setModels] = useState<PersonalAIModelOption[]>([]);
  const [customModel, setCustomModel] = useState(false);
  const [insightsEnabled, setInsightsEnabled] = useState(false);
  const [notificationsEnabled, setNotificationsEnabled] = useState(false);
  const [actionsEnabled, setActionsEnabled] = useState(false);
  const [connected, setConnected] = useState(false);
  const [connectionValidated, setConnectionValidated] = useState(false);
  const [savedModel, setSavedModel] = useState("");
  const [validatedAt, setValidatedAt] = useState<string | null>(null);
  const [consentRenewalRequired, setConsentRenewalRequired] = useState(false);
  const [busy, setBusy] = useState(false);
  const [catalogBusy, setCatalogBusy] = useState(false);
  const [testBusy, setTestBusy] = useState(false);
  const [testStatus, setTestStatus] = useState<PersonalAITestStatus | null>(null);
  const [usage, setUsage] = useState<PersonalAIUsage | null>(null);

  const getAccessToken = async () => {
    const { data } = await getSupabaseBrowserClient()?.auth.getSession() || {};
    return data?.session?.access_token || null;
  };
  const loadUsage = async (token: string) => {
    const response = await fetch("/api/personal-ai/usage", { headers: { Authorization: `Bearer ${token}`, "X-Valurise-Workspace-Id": workspaceId } });
    const result = await response.json();
    if (response.ok && result.usage) setUsage(result.usage);
  };

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const token = await getAccessToken();
      if (!token) return;
      const headers = { Authorization: `Bearer ${token}`, "X-Valurise-Workspace-Id": workspaceId };
      const [response, usageResponse] = await Promise.all([
        fetch("/api/personal-ai/connection", { headers }),
        fetch("/api/personal-ai/usage", { headers }).catch(() => null),
      ]);
      const result = await response.json();
      if (cancelled) return;
      if (response.ok && result.connection) {
        const storedProvider = result.connection.provider as PersonalAIProvider;
        const storedModel = String(result.connection.model || "");
        const initialModels = getInitialAIModelOptions(storedProvider);
        const selectedModel = storedProvider === "gemini" && !isSupportedGeminiModel(storedModel)
          ? defaultAIModel.gemini
          : storedModel;
        setConnected(true);
        setProvider(storedProvider);
        setModel(selectedModel);
        setModels(initialModels);
        setCustomModel(AI_PROVIDER_METADATA[storedProvider].supportsDynamicCatalog
          && !initialModels.some((item) => item.id === selectedModel));
        setSavedProvider(storedProvider);
        setSavedModel(storedModel);
        setConnectionValidated(Boolean(result.connection.validated && result.connection.validated_model === storedModel
          && (storedProvider !== "gemini" || isSupportedGeminiModel(storedModel))));
        setValidatedAt(result.connection.validated_at || null);
        setInsightsEnabled(result.connection.insights_enabled);
        setNotificationsEnabled(result.connection.notifications_enabled);
        setActionsEnabled(Boolean(result.connection.actions_enabled));
        setConsentRenewalRequired(Boolean(result.connection.consentRenewalRequired));
      }
      if (usageResponse?.ok) {
        const usageResult = await usageResponse.json();
        if (!cancelled && usageResult.usage) setUsage(usageResult.usage);
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [workspaceId]);

  const loadModels = async () => {
    if (!AI_PROVIDER_METADATA[provider].supportsDynamicCatalog) {
      setModels(getInitialAIModelOptions(provider));
      setCustomModel(false);
      setTestStatus(null);
      return;
    }
    const token = await getAccessToken();
    if (!token) return toast("Faça login novamente para consultar os modelos.");
    setCatalogBusy(true); setTestStatus(null);
    try {
      const response = await fetch("/api/personal-ai/models", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "X-Valurise-Workspace-Id": workspaceId },
        body: JSON.stringify({ provider, ...(apiKey.trim() ? { apiKey } : {}) }),
      });
      const result = await response.json();
      if (!response.ok) {
        setTestStatus({ ok: false, message: result.error || "Não foi possível carregar os modelos.", category: result.category, providerMessage: result.providerMessage, providerCode: result.providerCode, providerHttpStatus: result.providerHttpStatus, requestId: result.requestId, model: result.model || model });
        return;
      }
      const available = Array.isArray(result.models) ? result.models as PersonalAIModelOption[] : [];
      setModels(available);
      if (available.some((item) => item.id === model)) setCustomModel(false);
      else if (connected && savedProvider === provider) {
        setCustomModel(true);
        toast("O modelo salvo não apareceu no catálogo atual. Você pode testar o ID personalizado ou escolher outro.");
      } else {
        const recommended = available.find((item) => item.tier === "recommended") || available.find((item) => item.tier === "economical") || available[0];
        if (recommended) { setModel(recommended.id); setCustomModel(false); }
        else setCustomModel(true);
      }
      if (!available.length) toast("Nenhum modelo de texto compatível foi encontrado para essa chave.");
    } catch {
      setTestStatus({ ok: false, message: "Não foi possível carregar os modelos. Verifique sua conexão e tente novamente.", model });
    } finally { setCatalogBusy(false); }
  };

  const testConnection = async () => {
    if (!model.trim()) return toast("Escolha um modelo antes de testar.");
    if (provider === "gemini" && !isSupportedGeminiModel(model)) {
      return setTestStatus({ ok: false, message: "Selecione Gemini 2.5 Flash-Lite ou Gemini 2.5 Flash. Outros modelos não são usados pelo Valurise.", category: "INVALID_MODEL", providerCode: "MODEL_NOT_ALLOWED", model });
    }
    if ((!connected || provider !== savedProvider) && apiKey.trim().length < 12) return toast("Cole a API key para testar este provedor.");
    const token = await getAccessToken();
    if (!token) return toast("Faça login novamente para testar a conexão.");
    setTestBusy(true); setTestStatus({ ok: false, message: "Testando com uma solicitação mínima, sem dados financeiros…" });
    try {
      const response = await fetch("/api/personal-ai/test", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "X-Valurise-Workspace-Id": workspaceId },
        body: JSON.stringify({ provider, model, ...(apiKey.trim() ? { apiKey } : {}) }),
      });
      const result = await response.json();
      if (!response.ok) {
        setTestStatus({ ok: false, message: result.error || "Não foi possível validar a conexão.", category: result.category, providerMessage: result.providerMessage, providerCode: result.providerCode, providerHttpStatus: result.providerHttpStatus, requestId: result.requestId, model: result.model || model });
        return;
      }
      const tokenCount = typeof result.usage?.inputTokens === "number" && typeof result.usage?.outputTokens === "number"
        ? ` · ${result.usage.inputTokens + result.usage.outputTokens} tokens` : "";
      if (result.validated) {
        const testedAt = typeof result.validatedAt === "string" ? result.validatedAt : new Date().toISOString();
        setConnected(true);
        setSavedProvider(provider);
        setSavedModel(model);
        setConnectionValidated(true);
        setValidatedAt(testedAt);
        setApiKey("");
        setTestStatus({ ok: true, model: result.model || model, toolCallingValidated: Boolean(result.toolCallingValidated), message: `Conexão validada com ${result.model || model} · ${Number(result.latencyMs).toLocaleString("pt-BR")} ms${tokenCount}${result.toolCallingValidated ? " · ferramentas da Val confirmadas" : ""}` });
      } else {
        setTestStatus({ ok: true, model: result.model || model, toolCallingValidated: Boolean(result.toolCallingValidated), message: `${result.model || model} respondeu · ${Number(result.latencyMs).toLocaleString("pt-BR")} ms${tokenCount}${result.toolCallingValidated ? " · ferramentas da Val confirmadas" : ""}. Esta chave ou modelo ainda não está salvo; salve a configuração e teste novamente para liberar o chat.` });
      }
      await loadUsage(token);
    } catch {
      setTestStatus({ ok: false, message: "Não foi possível concluir o teste. Verifique sua conexão e tente novamente.", model });
    } finally { setTestBusy(false); }
  };

  const save = async () => {
    if (!model.trim()) return toast("Informe um modelo de texto válido.");
    if (provider === "gemini" && !isSupportedGeminiModel(model)) return toast("Selecione Gemini 2.5 Flash-Lite ou Gemini 2.5 Flash.");
    if ((!connected || provider !== savedProvider) && apiKey.trim().length < 12) return toast("Informe uma API key válida para este provedor.");
    const token = await getAccessToken();
    if (!token) return toast("Faça login novamente para conectar sua IA.");
    setBusy(true);
    try {
      const response = await fetch("/api/personal-ai/connection", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "X-Valurise-Workspace-Id": workspaceId },
        body: JSON.stringify({ provider, ...(apiKey.trim() ? { apiKey } : {}), model: model.trim(), insightsEnabled, notificationsEnabled, actionsEnabled: insightsEnabled && actionsEnabled }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Não foi possível salvar sua conexão.");
      setApiKey(""); setConnected(true); setSavedProvider(provider); setSavedModel(model);
      setConnectionValidated(Boolean(result.validated));
      setValidatedAt(typeof result.validatedAt === "string" ? result.validatedAt : null);
      setConsentRenewalRequired(false);
      setTestStatus(result.validated
        ? { ok: true, message: "Configuração salva. A conexão continua validada para este modelo." }
        : { ok: false, message: "Configuração salva, mas ainda não validada. Clique em “Testar conexão”; o chat será liberado quando o teste passar." });
      toast(result.pendingProposalsCancelled
        ? "Conexão salva. As propostas pendentes anteriores foram encerradas por segurança."
        : "Conexão salva. A chave foi protegida no servidor.");
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "Não foi possível salvar sua conexão.");
    } finally { setBusy(false); }
  };

  const disconnect = async () => {
    const token = await getAccessToken();
    if (!token) return;
    setBusy(true);
    try {
      const response = await fetch("/api/personal-ai/connection", { method: "DELETE", headers: { Authorization: `Bearer ${token}`, "X-Valurise-Workspace-Id": workspaceId } });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Não foi possível remover a conexão.");
      setConnected(false); setConnectionValidated(false); setSavedProvider(null); setSavedModel(""); setValidatedAt(null); setApiKey(""); setTestStatus(null); setUsage(null);
      setActionsEnabled(false);
      setConsentRenewalRequired(false);
      toast("Conexão de IA removida.");
    } catch (reason) { toast(reason instanceof Error ? reason.message : "Não foi possível remover a conexão."); }
    finally { setBusy(false); }
  };

  const currentConfigValidated = Boolean(connected && connectionValidated && provider === savedProvider && model === savedModel && !apiKey.trim());
  const tierLabel = (tier: PersonalAIModelOption["tier"]) => ({ recommended: "Recomendado", economical: "Rápido/econômico", advanced: "Mais capaz", other: "Outro" })[tier];
  const modelOptionLabel = (item: PersonalAIModelOption) => item.id === "openrouter/free"
    ? "OpenRouter Free · Recomendado"
    : `${item.label} · ${item.free ? "Gratuito" : tierLabel(item.tier)}`;
  const providerHelp = provider === "gemini"
    ? "O Valurise prioriza Gemini 2.5 Flash-Lite e Flash. O teste confirma chave, modelo e resposta sem enviar dados financeiros."
    : provider === "groq"
      ? "Atualize o catálogo para usar modelos ativos da sua chave. A Groq pode oferecer cota gratuita conforme a conta e o plano; disponibilidade e limites podem mudar."
      : provider === "openrouter"
        ? "OpenRouter Free é o roteador recomendado para modelos gratuitos disponíveis; limites e disponibilidade variam. O catálogo prioriza modelos gratuitos sem esconder os pagos."
        : "O catálogo indica compatibilidade de texto, não garante cota ou disponibilidade para sua conta. Escolha um modelo e teste antes de conversar.";
  return (
    <section className="panel mt-4 rounded-2xl p-5">
      <div className="flex items-start gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[var(--accent)]/15 text-[var(--accent)]"><Bot size={20} /></span>
        <div><b className="block">Val · assistente financeira</b><p className="muted mt-1 text-sm">Clareza para decidir hoje. Constância para prosperar amanhã. Conecte OpenAI, Gemini, DeepSeek, Groq ou OpenRouter usando sua própria conta.</p></div>
      </div>
      <div className="mt-5 grid gap-3">
        <label className="text-sm">Provedor
          <select value={provider} onChange={(event) => {
            const next = event.target.value as PersonalAIProvider;
            const initialModels = getInitialAIModelOptions(next);
            setProvider(next); setModel(defaultAIModel[next]); setModels(initialModels); setCustomModel(false); setTestStatus(null);
          }} className="field mt-1">
            {AI_PROVIDERS.map((item) => <option key={item} value={item}>{AI_PROVIDER_METADATA[item].label}</option>)}
          </select>
        </label>
        {provider === "gemini" ? <label className="text-sm">Modelo Gemini
          <select value={model} onChange={(event) => { setModel(event.target.value); setCustomModel(false); setTestStatus(null); }} className="field mt-1">
            {GEMINI_SUPPORTED_MODELS.map((item) => <option key={item.id} value={item.id}>{item.label} · {item.tier === "recommended" ? "Recomendado" : "Disponível"}</option>)}
          </select>
        </label> : models.length > 0 && <label className="text-sm">Modelos disponíveis para esta chave
          <select value={customModel || !models.some((item) => item.id === model) ? "__custom" : model} onChange={(event) => {
            if (event.target.value === "__custom") setCustomModel(true);
            else { setModel(event.target.value); setCustomModel(false); setTestStatus(null); }
          }} className="field mt-1">
          {models.map((item) => <option key={item.id} value={item.id}>{modelOptionLabel(item)}</option>)}
            <option value="__custom">Inserir modelo personalizado…</option>
          </select>
        </label>}
        {AI_PROVIDER_METADATA[provider].supportsDynamicCatalog && (models.length === 0 || customModel || !models.some((item) => item.id === model)) && <label className="text-sm">ID do modelo
          <input value={model} onChange={(event) => { setModel(event.target.value); setTestStatus(null); }} className="field mt-1" placeholder={defaultAIModel[provider]} autoComplete="off" />
        </label>}
        {AI_PROVIDER_METADATA[provider].supportsDynamicCatalog && <button type="button" disabled={catalogBusy} onClick={() => void loadModels()} className="min-h-10 w-fit rounded-xl bg-[var(--panel2)] px-3 text-xs font-semibold disabled:opacity-60">{catalogBusy ? "Consultando catálogo…" : "Atualizar modelos disponíveis"}</button>}
        <p className="muted -mt-1 text-xs leading-5">{providerHelp}</p>
        {connected && <p role="status" className={`rounded-xl px-3 py-2 text-xs leading-5 ${currentConfigValidated ? "bg-[var(--accent)]/10 text-[var(--accent)]" : "bg-[var(--panel2)] text-[var(--text)]"}`}>
          {currentConfigValidated
            ? `Conexão validada para ${savedModel}${validatedAt ? ` · ${new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(new Date(validatedAt))}` : ""}.`
            : "A configuração selecionada ainda não foi validada. Salve qualquer alteração e teste a conexão para liberar o chat."}
        </p>}
        <label className="text-sm">API key
          <input value={apiKey} onChange={(event) => { setApiKey(event.target.value); setTestStatus(null); }} className="field mt-1" type="password" autoComplete="new-password" placeholder={connected && provider === savedProvider ? "Salva e protegida · cole outra para substituir" : "Cole sua API key"} />
        </label>
        <PlanningCheckRow
          checked={insightsEnabled}
          ariaLabel="Autorizar uso dos meus dados financeiros pela Val"
          onChange={(checked) => { setInsightsEnabled(checked); if (!checked) { setNotificationsEnabled(false); setActionsEnabled(false); } }}
          label="Compartilhar dados para análise financeira"
          description={`Opcional: sua pergunta e os dados consultados serão enviados somente ao provedor escolhido (${AI_PROVIDER_METADATA[provider].label}), conforme a política dele.`}
          className="bg-[var(--panel2)]/50"
        />
        <PlanningCheckRow
          checked={notificationsEnabled && insightsEnabled}
          ariaLabel="Ativar notificações por IA"
          disabled={!insightsEnabled}
          onChange={setNotificationsEnabled}
          label="Notificações por IA"
          description="Desativadas até você permitir o contexto financeiro."
          className="bg-[var(--panel2)]/50"
        />
        <PlanningCheckRow
          checked={actionsEnabled && insightsEnabled}
          ariaLabel="Permitir propostas de receitas e despesas com confirmação obrigatória"
          disabled={!insightsEnabled}
          onChange={setActionsEnabled}
          label="Permitir ações financeiras com confirmação"
          description="Opcional. A Val só poderá preparar propostas de receita ou despesa comum. Cada proposta mostra os dados exatos e exige que você toque em “Confirmar e registrar”. Você pode descartar ou desligar esta permissão; não permite transferências, cartões/parcelas, investimentos, metas, edição ou exclusão."
          className="bg-[var(--panel2)]/50"
        />
      </div>
      {consentRenewalRequired && <p role="status" className="mt-3 rounded-xl bg-[var(--panel2)] px-3 py-2 text-xs leading-5">Atualizamos as regras de privacidade da Val. Para voltar a compartilhar contexto financeiro, revise o consentimento acima e salve a configuração.</p>}
      {testStatus && <div role="status" aria-live="polite" className={`mt-3 rounded-xl px-3 py-3 text-sm ${testStatus.ok ? "bg-[var(--accent)]/10 text-[var(--accent)]" : "bg-[var(--panel2)] text-[var(--danger)]"}`}>
        <p>{testStatus.message}</p>
        {!testStatus.ok && (testStatus.category || testStatus.model || testStatus.providerHttpStatus || testStatus.providerCode || testStatus.requestId || testStatus.providerMessage) && <div className="muted mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs">
          {testStatus.category && <b>{aiErrorCategoryLabels[testStatus.category] || "Falha de conexão"}</b>}
          {testStatus.model && <span>Modelo: {testStatus.model}</span>}
          {testStatus.providerHttpStatus && <span>HTTP do provedor: {testStatus.providerHttpStatus}</span>}
          {testStatus.providerCode && <span>Código: {testStatus.providerCode}</span>}
          {testStatus.requestId && <span>Referência: {testStatus.requestId}</span>}
        </div>}
        {!testStatus.ok && testStatus.providerMessage && <p className="muted mt-2 break-words text-xs">Detalhe retornado pelo provedor: {testStatus.providerMessage}</p>}
      </div>}
      <p className="muted mt-4 text-xs leading-5">A chave trafega ao servidor e é criptografada antes de ser salva; ela nunca volta ao navegador nem é enviada à Val como contexto. O teste envia uma pergunta mínima sem dados financeiros; Groq e OpenRouter também recebem uma solicitação de ferramenta fictícia, sem dados nem efeitos colaterais, para validar compatibilidade. Isso pode consumir alguns tokens do provedor escolhido. Sem a permissão acima, a Val não consulta informações financeiras. Com ela, ainda assim nada é gravado sem confirmação explícita no app; a aprovação é validada novamente no servidor. Desconectar revoga o consentimento e cancela propostas pendentes.</p>
      <div className="mt-4 flex flex-wrap gap-2">
        <button disabled={busy || testBusy} onClick={() => void save()} className="primary min-h-11 rounded-xl px-4 py-2 text-sm font-semibold">{busy ? "Salvando…" : connected ? "Salvar configuração" : "Conectar Val"}</button>
        <button disabled={testBusy || catalogBusy} onClick={() => void testConnection()} className="min-h-11 rounded-xl bg-[var(--panel2)] px-4 py-2 text-sm font-semibold">{testBusy ? "Testando…" : "Testar conexão"}</button>
        {connected && <button disabled={busy || testBusy} onClick={() => void disconnect()} className="min-h-11 rounded-xl px-4 py-2 text-sm text-[var(--danger)] hover:bg-[var(--panel2)]">Remover IA</button>}
      </div>
      <div className="mt-5 rounded-xl border border-[var(--border)] bg-[var(--panel2)] p-4">
        <b className="text-sm">Uso da Val neste mês</b>
        {usage ? <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs"><span className="muted">Solicitações <b className="text-[var(--text)]">{usage.requests.toLocaleString("pt-BR")}</b></span><span className="muted">Tokens medidos <b className="text-[var(--text)]">{usage.totalTokens.toLocaleString("pt-BR")}</b></span></div> : <p className="muted mt-2 text-xs">O uso aparecerá depois de uma conversa ou teste de conexão.</p>}
        <p className="muted mt-2 text-[11px] leading-4">Saldo de tokens e cota restante pertencem ao provedor e não são informados de forma consistente por estas APIs; a Valurise não inventa esse número.</p>
      </div>
    </section>
  );
}
function LegalPreferences({ toast }: { toast: (text: string) => void }) {
  return <div className="mt-4 border-t border-[var(--border)] pt-4"><p className="muted text-xs leading-5">Consulte os documentos vigentes e altere sua escolha sobre armazenamento opcional a qualquer momento.</p><div className="mt-3 flex flex-wrap gap-3 text-xs text-[var(--accent)]"><a href="/privacidade">Política de Privacidade</a><a href="/termos">Termos de Uso</a><a href="/cookies">Cookies e armazenamento local</a></div><button onClick={() => { window.dispatchEvent(new Event("valurise:manage-cookie-consent")); toast("Preferências de cookies abertas."); }} className="mt-4 min-h-11 rounded-xl bg-[var(--panel2)] px-4 text-xs font-medium">Gerenciar cookies</button></div>;
}
