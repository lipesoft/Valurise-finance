"use client";
import { useEffect, useMemo, useState } from "react";
import Image from "next/image";
import { AnimatePresence, LayoutGroup, motion, MotionConfig } from "framer-motion";
import {
  ArrowDownLeft,
  ArrowUpRight,
  BarChart3,
  Bell,
  CalendarDays,
  ChartNoAxesCombined,
  Check,
  ChevronLeft,
  ChevronRight,
  CirclePlus,
  CreditCard,
  Home,
  CircleHelp,
  Landmark,
  LogOut,
  Menu,
  PiggyBank,
  Plus,
  ReceiptText,
  Search,
  SlidersHorizontal,
  Target,
  Tags,
  WalletCards,
  X,
} from "lucide-react";
import { addMonths, format, isSameMonth, startOfMonth } from "date-fns";
import { ptBR } from "date-fns/locale";
import {
  calculateSummary,
  accountBalance,
  formatBRL,
  monthlyContributionNeeded,
  moneyAvailability,
  projectMonthEnd,
  type FinanceTransaction,
} from "@/lib/finance";
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
  }[];
  tags?: string[];
  recurringBills?: {
    id: string;
    name: string;
    amountCents: number;
    dueDay: number;
    category?: string;
    account?: string;
    frequency: "monthly" | "yearly";
    active: boolean;
    paidMonth?: string;
  }[];
  activity?: { id: string; text: string; date: string }[];
  monthlyReview?: Record<string, string[]>;
  dashboardWidgets?: { id: string; visible: boolean }[];
  onboarded: boolean;
};
const choices = [
  ["expense", "Gastei", ArrowUpRight],
  ["expense", "Paguei", ReceiptText],
  ["income", "Recebi", ArrowDownLeft],
  ["salary", "Salário", Landmark],
  ["investment", "Investi", BarChart3],
  ["transfer", "Transferi", WalletCards],
] as const;
const defaults = [
  "Alimentação",
  "Mercado",
  "Gasolina",
  "Transporte",
  "Moradia",
  "Saúde",
  "Lazer",
];
export default function Page() {
  const [user, setUser] = useState<User | null>(null);
  const [checkingAuth, setCheckingAuth] = useState(true);
  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) {
      const raw = localStorage.getItem("lume-user");
      if (raw) setUser(JSON.parse(raw));
      setCheckingAuth(false);
      return;
    }
    void supabase.auth.getUser().then(async ({ data }) => {
      if (!data.user) return;
      const { data: profile } = await supabase
        .from("profiles")
        .select("full_name, account_status, account_role")
        .eq("id", data.user.id)
        .maybeSingle();
      setUser({
        username: data.user.id,
        name: profile?.full_name || String(data.user.user_metadata?.full_name || "").trim() || data.user.email?.split("@")[0] || "Você",
        status: (profile?.account_status as AccountStatus | undefined) || "pending",
        role: profile?.account_role === "master" ? "master" : "user",
      });
    }).finally(() => setCheckingAuth(false));
  }, []);
  const logout = () => {
    localStorage.removeItem("lume-user");
    void getSupabaseBrowserClient()?.auth.signOut();
    setUser(null);
  };
  if (checkingAuth) return <main className="grid min-h-dvh place-items-center bg-[var(--bg)]"><span className="muted text-sm">Abrindo sua conta…</span></main>;
  if (user && user.status && user.status !== "active") return <AccountWaiting user={user} logout={logout} />;
  return user ? (
    <App
      user={user}
      logout={logout}
    />
  ) : (
    <Login done={setUser} />
  );
}
function Login({ done }: { done: (u: User) => void }) {
  const [mode, setMode] = useState<"login" | "signup" | "forgot" | "reset">(
    typeof window !== "undefined" && new URLSearchParams(window.location.search).has("reset-password") ? "reset" : "login",
  );
  const [u, setU] = useState(""), [p, setP] = useState(""), [name, setName] = useState(""), [username, setUsername] = useState(""), [e, setE] = useState(""), [notice, setNotice] = useState("");
  const supabase = getSupabaseBrowserClient();
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
      const { data, error } = await supabase.auth.signInWithPassword({
        email: u.trim(),
        password: p,
      });
      if (error || !data.user)
        return setE(error?.message || "Não foi possível entrar.");
      await finishSupabaseUser(data.user);
      return;
    }
    if (supabase && mode === "signup") {
      if (!name.trim() || !username.trim()) return setE("Informe seu nome e um usuário.");
      const { data, error } = await supabase.auth.signUp({
        email: u.trim(), password: p,
        options: { emailRedirectTo: `${window.location.origin}/?email-confirmed=1`, data: { full_name: name.trim(), username: username.trim().toLowerCase() } },
      });
      if (error || !data.user) return setE(error?.message || "Não foi possível solicitar o cadastro.");
      setNotice("Cadastro recebido. Aguarde a aprovação do Master.");
      await finishSupabaseUser(data.user);
      return;
    }
    if (supabase && mode === "forgot") {
      const { error } = await supabase.auth.resetPasswordForEmail(u.trim(), { redirectTo: `${window.location.origin}/?reset-password=1` });
      if (error) return setE(error.message);
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
    if (supabase) return setE("Preencha os dados solicitados.");
    const r = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: u, password: p }),
    });
    const d = await r.json();
    if (!r.ok) return setE(d.error);
    localStorage.setItem("lume-user", JSON.stringify(d.user));
    done(d.user);
  }
  return (
    <MotionConfig reducedMotion="user">
    <main className="login-shell grid min-h-dvh place-items-center overflow-hidden p-5">
      <LoginAmbient />
      <motion.form
        onSubmit={submit}
        className="login-card panel relative z-10 w-full max-w-sm rounded-3xl p-6"
        initial={{ opacity: 0, y: 12, scale: 0.99 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.36, ease: motionTokens.ease.enter }}
      >
        <motion.div
          className="inline-flex"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.24, delay: 0.08 }}
        >
          <Image src="/valurise-icon.webp" alt="Valurise" width={1254} height={1254} className="h-16 w-16 rounded-2xl" priority />
        </motion.div>
        <h1 className="mt-8 text-2xl font-semibold">Bem-vindo de volta.</h1>
        <p className="muted mt-2 text-sm">{mode === "signup" ? "Solicite seu acesso ao Valurise." : mode === "forgot" ? "Enviaremos um link seguro para seu e-mail." : mode === "reset" ? "Escolha uma nova senha segura." : "Seu espaço financeiro, só seu."}</p>
        {mode === "signup" && <><input value={name} onChange={(x) => setName(x.target.value)} className="field mt-7" placeholder="Seu nome" /><input value={username} onChange={(x) => setUsername(x.target.value)} className="field mt-3" placeholder="Usuário" /></>}
        <input
          value={u}
          onChange={(x) => setU(x.target.value)}
          className={`field ${mode === "signup" ? "mt-3" : "mt-7"}`}
          type="email"
          placeholder="Seu e-mail"
        />
        {mode !== "forgot" && <input
          value={p}
          onChange={(x) => setP(x.target.value)}
          className="field mt-3"
          type="password"
          placeholder={mode === "reset" ? "Nova senha" : "Senha"}
        />}
        <AnimatePresence>
          {e && (
            <motion.p
              className="mt-3 text-sm text-[var(--danger)]"
              initial={{ opacity: 0, y: -2 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: motionTokens.duration.fast }}
            >
              {e}
            </motion.p>
          )}
        </AnimatePresence>
        {notice && <p className="mt-3 text-sm text-[var(--accent)]">{notice}</p>}
        <button className="primary mt-5 h-12 w-full rounded-xl text-sm font-semibold">
          {mode === "signup" ? "Solicitar cadastro" : mode === "forgot" ? "Enviar link" : mode === "reset" ? "Salvar nova senha" : "Entrar"}
        </button>
        {supabase && <div className="mt-4 flex flex-wrap justify-center gap-x-4 gap-y-2 text-xs text-[var(--accent)]">
          {mode !== "login" && <button type="button" onClick={() => { setMode("login"); setE(""); setNotice(""); }}>Já tenho acesso</button>}
          {mode === "login" && <><button type="button" onClick={() => { setMode("forgot"); setE(""); }}>Esqueci minha senha</button><button type="button" onClick={() => { setMode("signup"); setE(""); }}>Criar conta</button></>}
        </div>}
      </motion.form>
    </main>
    </MotionConfig>
  );
}
function AccountWaiting({ user, logout }: { user: User; logout: () => void }) {
  const copy = user.status === "pending" ? { title: "Esperando aprovação do Master", text: "Seu cadastro foi recebido. Você será avisado assim que seu acesso for aprovado." } : user.status === "trashed" ? { title: "Conta na lixeira", text: "Esta conta foi removida temporariamente. Fale com o Master para restaurá-la." } : { title: "Conta desativada", text: "Seu acesso está desativado. Fale com o Master se precisar de ajuda." };
  return <main className="login-shell grid min-h-dvh place-items-center overflow-hidden p-5"><LoginAmbient /><section className="login-card panel relative z-10 w-full max-w-sm rounded-3xl p-7 text-center"><Image src="/valurise-icon.webp" alt="Valurise" width={512} height={512} className="mx-auto h-16 w-16" priority /><h1 className="mt-7 text-xl font-semibold">{copy.title}</h1><p className="muted mt-3 text-sm leading-6">{copy.text}</p><button onClick={logout} className="mt-7 rounded-xl bg-[var(--panel2)] px-4 py-3 text-sm">Sair desta conta</button></section></main>;
}
function App({ user, logout }: { user: User; logout: () => void }) {
  const key = `lume:v2:${user.username}`;
  const [data, setData] = useState<Data>({
    categories: [],
    institutions: [],
    onboarded: false,
  });
  const [tx, setTx] = useState<FinanceTransaction[]>([]);
  const [view, setView] = useState<View>("dashboard");
  const [sheet, setSheet] = useState(false);
  const [mobileMenu, setMobileMenu] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [profile, setProfile] = useState<ProfilePreference>({ publicId: "" });
  const [theme, setTheme] = useState("dark");
  const [systemPrefersLight, setSystemPrefersLight] = useState(false);
  const [toast, setToast] = useState("");
  const [month, setMonth] = useState(startOfMonth(new Date()));
  useEffect(() => {
    let stale = false;
    void (async () => {
      try {
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
        const remote = await loadValuriseState<
          Data,
          FinanceTransaction,
          ProfilePreference
        >();
        if (stale) return;
        const state = remote || {
          data: localData,
          transactions: localTx,
          profile: localProfile,
        };
        setData(state.data);
        setTx(state.transactions);
        setProfile(state.profile);
        if (!remote) void saveValuriseState(state);
      } catch {}
    })();
    return () => {
      stale = true;
    };
  }, [key, user.username]);
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
    setData(next);
    localStorage.setItem(key + ":data", JSON.stringify(next));
    void saveValuriseState({ data: next, transactions: tx, profile });
  };
  const saveTx = (next: FinanceTransaction[]) => {
    setTx(next);
    localStorage.setItem(key + ":tx", JSON.stringify(next));
    void saveValuriseState({ data, transactions: next, profile });
  };
  const saveProfile = (next: ProfilePreference) => {
    setProfile(next);
    localStorage.setItem(key + ":profile", JSON.stringify(next));
    void saveValuriseState({ data, transactions: tx, profile: next });
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
  );
  if (!data.onboarded)
    return (
      <Onboard
        user={user}
        finish={(n) => saveData({ ...n, onboarded: true })}
      />
    );
  const setT = (next: string) => {
    setTheme(next);
    localStorage.setItem(key + ":theme", next);
  };
  const useLightTheme =
    theme === "light" || (theme === "system" && systemPrefersLight);
  return (
    <MotionConfig reducedMotion="user">
    <main className={useLightTheme ? "light min-h-dvh" : "min-h-dvh"}>
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
      <section className="mx-auto max-w-6xl pb-[calc(11rem+env(safe-area-inset-bottom))] lg:ml-60 lg:pb-40">
        <header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b border-[var(--border)] bg-[var(--bg)]/95 px-4 backdrop-blur-xl lg:px-10">
          <div className="lg:hidden">
            <Brand />
          </div>
          <div className="flex items-center gap-2">
            <button
              aria-label="Buscar em todo o Valurise"
              onClick={() => setSearchOpen(true)}
              className="grid h-9 w-9 place-items-center rounded-xl bg-[var(--panel2)]"
            >
              <Search size={18} />
            </button>
            <button
              aria-label={`Abrir notificações${notifications.length ? ` (${notifications.length})` : ""}`}
              onClick={() => setNotificationsOpen((open) => !open)}
              className="relative grid h-9 w-9 place-items-center rounded-xl bg-[var(--panel2)]"
            >
              <Bell size={18} />
              {notifications.length > 0 && (
                <span className="absolute -right-1 -top-1 grid h-4 min-w-4 place-items-center rounded-full bg-[var(--accent)] px-1 text-[9px] font-bold text-[var(--accentfg)]">
                  {notifications.length > 9 ? "9+" : notifications.length}
                </span>
              )}
            </button>
            <button
              aria-label="Abrir perfil"
              onClick={() => setProfileOpen(true)}
              className="grid h-9 w-9 overflow-hidden place-items-center rounded-full bg-[var(--panel2)] text-xs font-medium"
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
              className="grid h-9 w-9 place-items-center rounded-xl bg-[var(--panel2)] lg:hidden"
            >
              <Menu size={18} />
            </button>
          </div>
        </header>
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
            sum={sum}
            total={total}
            tx={current}
            allTx={tx}
            data={data}
            save={saveData}
            month={month}
            setMonth={setMonth}
            go={setView}
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
          <Investments data={data} save={saveData} toast={setToast} />
        )}
        {view === "budgets" && (
          <Budgets data={data} tx={tx} month={month} save={saveData} toast={setToast} />
        )}
        {view === "goals" && (
          <Goals data={data} save={saveData} toast={setToast} />
        )}
        {view === "categories" && (
          <Categories data={data} tx={tx} month={month} save={saveData} toast={setToast} />
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
            toast={setToast}
          />
        )}
        </AnimatedPage>
        </AnimatePresence>
        <button
          aria-label="Registrar movimentação"
          onClick={() => setSheet(true)}
          className={
            view === "dashboard"
              ? "panel fixed bottom-[max(18px,env(safe-area-inset-bottom))] left-4 right-4 z-20 mx-auto flex max-w-xl items-center gap-3 rounded-2xl p-3 text-left shadow-2xl lg:left-[calc(50%+120px)] lg:right-auto lg:w-[600px] lg:-translate-x-1/2"
              : "primary fixed bottom-[max(22px,env(safe-area-inset-bottom))] right-5 z-20 grid h-14 w-14 place-items-center rounded-full shadow-2xl lg:right-10"
          }
        >
          {view === "dashboard" ? (
            <>
              <span className="primary grid h-10 w-10 place-items-center rounded-xl">
                <FinanceChatIcon />
              </span>
              <span>
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
            createCategory={createCategory}
            createInvestment={createInvestment}
            close={() => setSheet(false)}
            saved={(n) => {
              saveTx([...n, ...tx]);
              const transaction = n[0];
              if (transaction?.type === "investment") {
                const investments = (data.investments || []).map((item: any) =>
                  item.id === transaction.investmentId ||
                  (!transaction.investmentId && item.name === transaction.category)
                    ? {
                        ...item,
                        contributedCents:
                          item.contributedCents + transaction.amountCents,
                        currentCents:
                          item.currentCents === undefined
                            ? undefined
                            : item.currentCents + transaction.amountCents,
                      }
                    : item,
                );
                saveData({ ...data, investments });
              }
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
    if (!bill.active || bill.paidMonth === month) return;
    if (bill.dueDay < day) {
      items.push({
        id: `late-${bill.id}`,
        title: `${bill.name} está atrasada`,
        text: `Venceu no dia ${bill.dueDay}. Marque como paga ou confira o lançamento.`,
        tone: "danger",
        view: "planning",
      });
    } else if (bill.dueDay - day <= 3) {
      items.push({
        id: `due-${bill.id}`,
        title: `${bill.name} vence em ${bill.dueDay - day} dia(s)`,
        text: `${formatBRL(bill.amountCents)} · vencimento dia ${bill.dueDay}.`,
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
        id: `budget-over-${budget.id}`,
        title: `${budget.category} ultrapassou o orçamento`,
        text: `Você usou ${formatBRL(spent)} de ${formatBRL(budget.limitCents)}.`,
        tone: "danger",
        view: "budgets",
      });
    } else if (percent >= 80) {
      items.push({
        id: `budget-${budget.id}`,
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
      id: `goal-${goal.id}`,
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
  close,
  go,
}: {
  items: AppNotification[];
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
      <div className="flex items-center justify-between px-2 py-2">
        <div>
          <b>Notificações</b>
          <p className="muted mt-0.5 text-xs">Alertas importantes para seu mês</p>
        </div>
        <button aria-label="Fechar notificações" onClick={close} className="rounded-lg p-2 hover:bg-[var(--panel2)]">
          <X size={17} />
        </button>
      </div>
      {items.length ? (
        <div className="mt-1 divide-y divide-[var(--border)]">
          {items.map((item) => (
            <button
              key={item.id}
              onClick={() => go(item.view)}
              className="flex w-full items-start gap-3 px-2 py-3 text-left hover:bg-[var(--panel2)]"
            >
              <span
                className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${item.tone === "danger" ? "bg-[var(--danger)]" : item.tone === "warning" ? "bg-amber-400" : "bg-[var(--accent)]"}`}
              />
              <span className="min-w-0">
                <b className="block text-sm">{item.title}</b>
                <small className="muted mt-1 block leading-4">{item.text}</small>
              </span>
            </button>
          ))}
        </div>
      ) : (
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
      width="23"
      height="23"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M5 5.5A3.5 3.5 0 0 1 8.5 2h7A3.5 3.5 0 0 1 19 5.5v5A3.5 3.5 0 0 1 15.5 14H12l-3.6 3.1c-.65.56-1.65.1-1.65-.76V14A3.5 3.5 0 0 1 5 10.5v-5Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path
        d="m11.25 6.3.55 1.9 1.9.55-1.9.55-.55 1.9-.55-1.9-1.9-.55 1.9-.55.55-1.9Z"
        fill="currentColor"
      />
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
function Brand({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 font-semibold tracking-[-0.04em] ${className}`}>
      <Image src="/valurise-icon.webp" alt="Logo Valurise" width={1254} height={1254} className="h-7 w-7 rounded-lg" priority />
      <span className="text-lg">VALURISE</span>
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
            onClick={() =>
              toast(
                "A alteração de senha será liberada quando a autenticação Supabase for conectada.",
              )
            }
            className="mt-3 flex w-full items-center justify-between rounded-xl bg-[var(--panel2)] px-4 py-3 text-left text-sm"
          >
            <span>Alterar senha</span>
            <span className="muted text-xs">Em breve</span>
          </button>
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
function Dashboard({
  user,
  sum,
  total,
  tx,
  allTx,
  data,
  save,
  month,
  setMonth,
  go,
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
      <GoalPreview key={id} data={data} go={go} />
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
  const upcoming = [...bills]
    .filter(
      (bill: any) => bill.paidMonth !== key && bill.dueDay >= today.getDate(),
    )
    .sort((a: any, b: any) => a.dueDay - b.dueDay)
    .slice(0, 3);
  const late = bills.filter(
    (bill: any) => bill.paidMonth !== key && bill.dueDay < today.getDate(),
  ).length;
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
        {Array.from(
          { length: 7 },
          (_, offset) =>
            new Date(
              today.getFullYear(),
              today.getMonth(),
              today.getDate() + offset,
            ),
        ).map((day) => {
          const dayBills = bills.filter(
            (bill: any) =>
              bill.dueDay === day.getDate() && bill.paidMonth !== key,
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
          {upcoming.slice(0, 2).map((bill: any) => (
            <div
              key={bill.id}
              className="flex items-center justify-between text-xs"
            >
              <span className="truncate">
                <b>{bill.name}</b>
                <small className="muted"> · dia {bill.dueDay}</small>
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
  (data.recurringBills || [])
    .filter(
      (bill: any) =>
        bill.active &&
        bill.dueDay >= today.getDate() &&
        bill.dueDay - today.getDate() <= 3,
    )
    .forEach((bill: any) =>
      insights.push(
        `${bill.name} vence em ${bill.dueDay - today.getDate()} dia(s).`,
      ),
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
function GoalPreview({ data, go }: any) {
  const goal = data.goals?.[0];
  if (!goal)
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
  const percentage = Math.min(
    100,
    Math.round((goal.currentCents / goal.targetCents) * 100),
  );
  return (
    <section className="panel rounded-2xl p-5">
      <PreviewHeader
        icon={<Target size={16} />}
        title="Metas"
        action={() => go("goals")}
      />
      <div className="mt-5">
        <div className="flex justify-between text-sm">
          <span>{goal.name}</span>
          <span className="muted">{percentage}%</span>
        </div>
        <div className="mt-3 h-2 overflow-hidden rounded-full bg-[var(--panel2)]">
          <AnimatedProgress
            value={percentage}
            className="block h-full rounded-full bg-[var(--accent)]"
          />
        </div>
        <p className="muted mt-3 text-xs">
          {formatBRL(goal.currentCents)} de {formatBRL(goal.targetCents)}
        </p>
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
        className="muted grid h-8 w-8 place-items-center rounded-full bg-[var(--panel2)] hover:text-[var(--accent)]"
      >
        <CircleHelp size={17} />
      </button>
      {onAdd && (
        <button
          aria-label={addLabel}
          onClick={onAdd}
          className="primary ml-auto grid h-9 w-9 place-items-center rounded-xl shadow-sm"
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
function Investments({ data, save, toast }: any) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [contributed, setContributed] = useState("");
  const [current, setCurrent] = useState("");
  const [assetClass, setAssetClass] = useState("Renda fixa");
  const [rate, setRate] = useState("");
  const [aporteFor, setAporteFor] = useState("");
  const [aporte, setAporte] = useState("");
  const items = data.investments || [];
  const add = () => {
    const cents = Math.round(Number(contributed.replace(",", ".")) * 100);
    if (!name.trim() || !cents) return;
    save({
      ...data,
      investments: [
        ...items,
        {
          id: crypto.randomUUID(),
          name: name.trim(),
          contributedCents: cents,
          currentCents: current
            ? Math.round(Number(current.replace(",", ".")) * 100)
            : undefined,
          assetClass,
          expectedAnnualRate: rate ? Number(rate.replace(",", ".")) : undefined,
        },
      ],
    });
    toast("Investimento salvo com sucesso.");
    setName("");
    setContributed("");
    setCurrent("");
    setAssetClass("Renda fixa");
    setRate("");
    setAdding(false);
  };
  const addAporte = () => {
    const cents = Math.round(Number(aporte.replace(",", ".")) * 100);
    if (!aporteFor || !cents) return;
    save({
      ...data,
      investments: items.map((item: any) =>
        item.id === aporteFor
          ? {
              ...item,
              contributedCents: item.contributedCents + cents,
              currentCents:
                item.currentCents === undefined
                  ? undefined
                  : item.currentCents + cents,
            }
          : item,
      ),
    });
    toast("Aporte registrado com sucesso.");
    setAporte("");
    setAporteFor("");
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
              <button
                onClick={() => setAporteFor(item.id)}
                className="mt-3 text-sm font-medium text-[var(--accent)]"
              >
                + Registrar aporte
              </button>
            </article>
          ))}
        </div>
      ) : (
        <Empty text="Você ainda não possui investimentos cadastrados." />
      )}
      {aporteFor && (
        <section className="panel mt-5 space-y-3 rounded-2xl p-4">
          <div className="flex items-center justify-between">
            <b className="text-sm">Novo aporte</b>
            <button
              onClick={() => setAporteFor("")}
              aria-label="Cancelar aporte"
            >
              <X size={16} />
            </button>
          </div>
          <p className="muted text-sm">
            Esse valor soma ao total já aportado no investimento.
          </p>
          <input
            autoFocus
            className="field"
            value={aporte}
            onChange={(e) => setAporte(e.target.value)}
            inputMode="decimal"
            placeholder="Valor do aporte"
          />
          <button
            onClick={addAporte}
            className="primary h-11 w-full rounded-xl text-sm"
          >
            Registrar aporte
          </button>
        </section>
      )}
      {adding && (
        <Sheet close={() => setAdding(false)}>
          <section className="space-y-3">
            <b className="text-lg">Novo investimento</b>
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
              placeholder="Valor aportado"
            />
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
              onClick={add}
              className="primary h-11 w-full rounded-xl text-sm"
            >
              Salvar investimento
            </button>
          </section>
        </Sheet>
      )}
    </section>
  );
}
function Budgets({ data, tx, month, save, toast }: any) {
  const [adding, setAdding] = useState(false);
  const [category, setCategory] = useState("");
  const [limit, setLimit] = useState("");
  const items = data.budgets || [];
  const add = () => {
    const cents = Math.round(Number(limit.replace(",", ".")) * 100);
    if (!category.trim() || !cents) return;
    save({
      ...data,
      budgets: [
        ...items,
        {
          id: crypto.randomUUID(),
          category: category.trim(),
          limitCents: cents,
          month: format(month, "yyyy-MM"),
        },
      ],
    });
    toast("Orçamento criado com sucesso.");
    setCategory("");
    setLimit("");
    setAdding(false);
  };
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
              </article>
            );
          })}
        </div>
      ) : (
        <Empty text="Nenhum orçamento criado." />
      )}
      {adding && (
        <Sheet close={() => setAdding(false)}>
          <section className="space-y-3">
            <b className="text-lg">Criar orçamento</b>
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
              onClick={add}
              className="primary h-11 w-full rounded-xl text-sm"
            >
              Criar orçamento
            </button>
          </section>
        </Sheet>
      )}
    </section>
  );
}
function Goals({ data, save, toast }: any) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  const [current, setCurrent] = useState("");
  const [targetDate, setTargetDate] = useState("");
  const [contributionFor, setContributionFor] = useState("");
  const [contribution, setContribution] = useState("");
  const items = data.goals || [];
  const add = () => {
    const targetCents = Math.round(Number(target.replace(",", ".")) * 100);
    if (!name.trim() || !targetCents) return;
    save({
      ...data,
      goals: [
        ...items,
        {
          id: crypto.randomUUID(),
          name: name.trim(),
          targetCents,
          currentCents:
            Math.round(Number(current.replace(",", ".")) * 100) || 0,
          targetDate: targetDate || undefined,
        },
      ],
    });
    toast("Meta criada com sucesso.");
    setName("");
    setTarget("");
    setCurrent("");
    setTargetDate("");
    setAdding(false);
  };
  const contribute = () => {
    const cents = Math.round(Number(contribution.replace(",", ".")) * 100);
    if (!contributionFor || !cents) return;
    save({
      ...data,
      goals: items.map((item: any) =>
        item.id === contributionFor
          ? { ...item, currentCents: item.currentCents + cents }
          : item,
      ),
    });
    toast("Contribuição adicionada à meta.");
    setContribution("");
    setContributionFor("");
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
      {items.length ? (
        <div className="mt-5 space-y-3">
          {items.map((item: any) => {
            const percentage = Math.min(
              100,
              Math.round((item.currentCents / item.targetCents) * 100),
            );
            return (
              <article className="panel rounded-2xl p-4" key={item.id}>
                <div className="flex justify-between gap-3">
                  <b>{item.name}</b>
                  <span className="text-sm">{percentage}%</span>
                </div>
                <div className="mt-3 h-2 overflow-hidden rounded-full bg-[var(--panel2)]">
                  <AnimatedProgress
                    value={percentage}
                    className="block h-full bg-[var(--accent)]"
                  />
                </div>
                <p className="muted mt-2 text-sm">
                  {formatBRL(item.currentCents)} de{" "}
                  {formatBRL(item.targetCents)}
                </p>
                {item.targetDate && (
                  <p className="muted mt-1 text-xs">
                    Para cumprir até{" "}
                    {format(
                      new Date(`${item.targetDate}T12:00:00`),
                      "dd/MM/yyyy",
                    )}
                    :{" "}
                    {formatBRL(
                      monthlyContributionNeeded(
                        item.targetCents,
                        item.currentCents,
                        item.targetDate,
                      ),
                    )}
                    /mês
                  </p>
                )}
                <button
                  onClick={() => setContributionFor(item.id)}
                  className="mt-3 text-sm font-medium text-[var(--accent)]"
                >
                  + Adicionar dinheiro
                </button>
              </article>
            );
          })}
        </div>
      ) : (
        <Empty text="Nenhuma meta criada." />
      )}
      {contributionFor && (
        <section className="panel mt-5 space-y-3 rounded-2xl p-4">
          <div className="flex items-center justify-between">
            <b className="text-sm">Adicionar dinheiro à meta</b>
            <button
              onClick={() => setContributionFor("")}
              aria-label="Cancelar contribuição"
            >
              <X size={16} />
            </button>
          </div>
          <input
            autoFocus
            value={contribution}
            onChange={(e) => setContribution(e.target.value)}
            inputMode="decimal"
            className="field"
            placeholder="Valor da contribuição"
          />
          <button
            onClick={contribute}
            className="primary h-11 w-full rounded-xl text-sm"
          >
            Adicionar à meta
          </button>
        </section>
      )}
      {adding && (
        <Sheet close={() => setAdding(false)}>
          <section className="space-y-3">
            <b className="text-lg">Criar meta</b>
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
              placeholder="Valor inicial (opcional)"
            />
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
              onClick={add}
              className="primary h-11 w-full rounded-xl text-sm"
            >
              Criar meta
            </button>
          </section>
        </Sheet>
      )}
    </section>
  );
}
function Empty({ text }: any) {
  return <p className="muted mt-4 text-sm">{text}</p>;
}
function Planning({ data, tx, month, save, toast }: any) {
  const [adding, setAdding] = useState(false);
  const [calendarMonth, setCalendarMonth] = useState(month);
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [dueDay, setDueDay] = useState("");
  const [category, setCategory] = useState("");
  const bills = data.recurringBills || [];
  const today = new Date();
  const upcoming = [...bills]
    .filter((bill: any) => bill.active)
    .sort((a: any, b: any) => a.dueDay - b.dueDay);
  const monthlyCommitted = upcoming
    .filter((bill: any) => bill.frequency === "monthly")
    .reduce((total: number, bill: any) => total + bill.amountCents, 0);
  const currentMonth = format(month, "yyyy-MM");
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
    isSameMonth(month, today) ? today.getDate() : new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate(),
    new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate(),
  );
  const paidCount = bills.filter(
    (bill: any) => bill.paidMonth === currentMonth,
  ).length;
  const lateCount = bills.filter(
    (bill: any) =>
      bill.active &&
      bill.paidMonth !== currentMonth &&
      bill.dueDay < today.getDate(),
  ).length;
  const pendingCount = bills.filter(
    (bill: any) =>
      bill.active &&
      bill.paidMonth !== currentMonth &&
      bill.dueDay >= today.getDate(),
  ).length;
  const add = () => {
    const amountCents = Math.round(Number(amount.replace(",", ".")) * 100);
    const due = Number(dueDay);
    if (!name.trim() || !amountCents || due < 1 || due > 31) return;
    save({
      ...data,
      recurringBills: [
        ...bills,
        {
          id: crypto.randomUUID(),
          name: name.trim(),
          amountCents,
          dueDay: due,
          category: category.trim() || undefined,
          frequency: "monthly",
          active: true,
        },
      ],
    });
    toast("Conta recorrente criada com sucesso.");
    setName("");
    setAmount("");
    setDueDay("");
    setCategory("");
    setAdding(false);
  };
  return (
    <section className="mx-auto max-w-3xl px-4 pt-8">
      <SectionTitle
        title="Planejamento"
        help="Cadastre contas recorrentes para enxergar compromissos futuros e receber avisos dentro da Valurise."
        onAdd={() => setAdding(true)}
        addLabel="Adicionar conta recorrente"
      />
      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <section className="panel rounded-2xl p-5">
          <p className="muted text-xs">COMPROMETIDO TODO MÊS</p>
          <b className="mt-2 block text-2xl">{formatBRL(monthlyCommitted)}</b>
          <p className="muted mt-2 text-sm">
            {upcoming.length} conta{upcoming.length === 1 ? "" : "s"} recorrente
            {upcoming.length === 1 ? "" : "s"} ativa
            {upcoming.length === 1 ? "" : "s"}
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
      />
      <section className="panel mt-4 rounded-2xl p-5">
        <div className="flex items-center justify-between">
          <b>Próximos vencimentos</b>
          <span className="muted text-xs">alertas no app</span>
        </div>
        {upcoming.length ? (
          <div className="mt-3 divide-y divide-[var(--border)]">
            {upcoming.map((bill: any) => (
              <div
                key={bill.id}
                className="flex items-center justify-between py-3"
              >
                <span>
                  <b className="block text-sm">{bill.name}</b>
                  <small className="muted">
                    vence dia {bill.dueDay}
                    {bill.category ? ` · ${bill.category}` : ""}
                  </small>
                </span>
                <b className="text-sm">{formatBRL(bill.amountCents)}</b>
              </div>
            ))}
          </div>
        ) : (
          <Empty text="Nenhuma conta recorrente. Adicione aluguel, internet, assinaturas ou faturas." />
        )}
      </section>
      <CardInvoicePreview data={data} tx={tx} />
      <MonthlyReview data={data} save={save} />
      {adding && (
        <Sheet close={() => setAdding(false)}>
          <section className="space-y-3">
            <b className="text-lg">Nova conta recorrente</b>
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
              placeholder="Valor mensal"
            />
            <input
              className="field"
              value={dueDay}
              onChange={(e) => setDueDay(e.target.value)}
              inputMode="numeric"
              placeholder="Dia de vencimento"
            />
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
              onClick={add}
              className="primary h-11 w-full rounded-xl text-sm"
            >
              Criar conta recorrente
            </button>
          </section>
        </Sheet>
      )}
    </section>
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
            <button
              key={step.id}
              onClick={() => toggle(step.id)}
              className={`flex w-full items-center gap-3 rounded-xl p-3 text-left transition ${done ? "bg-[var(--accent)]/10" : "hover:bg-[var(--panel2)]"}`}
            >
              <span
                className={`grid h-8 w-8 shrink-0 place-items-center rounded-full text-xs font-semibold ${done ? "bg-[var(--accent)] text-[var(--accentfg)]" : "bg-[var(--panel2)] text-[var(--muted)]"}`}
              >
                {done ? <Check size={16} /> : index + 1}
              </span>
              <span className="min-w-0 flex-1">
                <b
                  className={`block text-sm ${done ? "text-[var(--accent)]" : ""}`}
                >
                  {step.title}
                </b>
                <small className="muted mt-0.5 block leading-4">
                  {step.text}
                </small>
              </span>
              {done && (
                <span className="text-xs font-medium text-[var(--accent)]">
                  Feito
                </span>
              )}
            </button>
          );
        })}
      </div>
    </section>
  );
}
function FinancialCalendar({ month, setMonth, bills, save, data, toast }: any) {
  const [selectedDay, setSelectedDay] = useState<number | null>(null);
  const key = format(month, "yyyy-MM");
  const today = new Date();
  const isCurrent = key === format(today, "yyyy-MM");
  const firstWeekday =
    (new Date(month.getFullYear(), month.getMonth(), 1).getDay() + 6) % 7;
  const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const cells = Array.from(
    { length: Math.ceil((firstWeekday + days) / 7) * 7 },
    (_, index) => index - firstWeekday + 1,
  );
  const dayBills = (day: number) =>
    bills.filter((bill: any) => bill.active && bill.dueDay === day);
  const status = (bill: any) =>
    bill.paidMonth === key
      ? "paid"
      : isCurrent && bill.dueDay < today.getDate()
        ? "late"
        : "pending";
  const togglePaid = (bill: any) => {
    const paid = bill.paidMonth !== key;
    save({
      ...data,
      recurringBills: bills.map((item: any) =>
        item.id === bill.id
          ? { ...item, paidMonth: paid ? key : undefined }
          : item,
      ),
    });
    toast(
      paid
        ? `${bill.name} marcada como paga.`
        : `${bill.name} voltou para pendente.`,
    );
  };
  const selected = selectedDay ? dayBills(selectedDay) : [];
  return (
    <section className="panel mt-4 rounded-2xl p-4 sm:p-5">
      <div className="flex items-center justify-between">
        <div>
          <b>Calendário financeiro</b>
          <p className="muted mt-1 text-xs">
            Vencimentos e status das suas contas
          </p>
        </div>
        <span className="grid h-8 w-8 place-items-center rounded-xl bg-[var(--panel2)] text-[var(--accent)]">
          <CalendarDays size={16} />
        </span>
      </div>
      <div className="mt-4 flex items-center justify-between">
        <button
          aria-label="Mês anterior"
          onClick={() => setMonth(startOfMonth(addMonths(month, -1)))}
          className="rounded-lg p-2 hover:bg-[var(--panel2)]"
        >
          <ChevronLeft size={18} />
        </button>
        <b className="capitalize text-sm">
          {format(month, "MMMM yyyy", { locale: ptBR })}
        </b>
        <button
          aria-label="Próximo mês"
          onClick={() => setMonth(startOfMonth(addMonths(month, 1)))}
          className="rounded-lg p-2 hover:bg-[var(--panel2)]"
        >
          <ChevronRight size={18} />
        </button>
      </div>
      <div className="mt-3 grid grid-cols-7 text-center text-[10px] text-[var(--muted)]">
        {["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"].map((day) => (
          <span key={day}>{day}</span>
        ))}
      </div>
      <div className="mt-2 grid grid-cols-7 gap-1">
        {cells.map((day, index) => {
          const items = day > 0 && day <= days ? dayBills(day) : [];
          const hasLate = items.some((bill: any) => status(bill) === "late");
          const hasPending = items.some(
            (bill: any) => status(bill) === "pending",
          );
          const hasPaid = items.some((bill: any) => status(bill) === "paid");
          const todayCell = isCurrent && day === today.getDate();
          return (
            <button
              key={index}
              disabled={!items.length}
              onClick={() => setSelectedDay(day)}
              className={`relative min-h-12 rounded-xl p-1 text-left text-xs ${items.length ? "bg-[var(--panel2)] hover:ring-1 hover:ring-[var(--accent)]" : ""} ${todayCell ? "ring-1 ring-[var(--accent)]" : ""} disabled:cursor-default`}
            >
              <span
                className={`grid h-5 w-5 place-items-center rounded-full ${todayCell ? "bg-[var(--accent)] text-[var(--accentfg)]" : ""}`}
              >
                {day > 0 && day <= days ? day : ""}
              </span>
              {items.length > 0 && (
                <span
                  className={`absolute bottom-2 left-1/2 h-1.5 w-1.5 -translate-x-1/2 rounded-full ${hasLate ? "bg-[var(--danger)]" : hasPending ? "bg-amber-400" : hasPaid ? "bg-[var(--accent)]" : ""}`}
                />
              )}
            </button>
          );
        })}
      </div>
      <div className="muted mt-3 flex flex-wrap gap-3 text-[11px]">
        <span>
          <i className="mr-1 inline-block h-2 w-2 rounded-full bg-amber-400" />
          Pendente
        </span>
        <span>
          <i className="mr-1 inline-block h-2 w-2 rounded-full bg-[var(--danger)]" />
          Atrasada
        </span>
        <span>
          <i className="mr-1 inline-block h-2 w-2 rounded-full bg-[var(--accent)]" />
          Paga
        </span>
      </div>
      {selectedDay && (
        <div className="mt-4 border-t border-[var(--border)] pt-4">
          <div className="flex justify-between">
            <b className="text-sm">Dia {selectedDay}</b>
            <button
              onClick={() => setSelectedDay(null)}
              aria-label="Fechar detalhes do dia"
            >
              <X size={16} />
            </button>
          </div>
          <div className="mt-2 space-y-2">
            {selected.map((bill: any) => (
              <div
                key={bill.id}
                className="flex items-center justify-between rounded-xl bg-[var(--panel2)] p-3 text-sm"
              >
                <span>
                  <b className="block">{bill.name}</b>
                  <small className="muted">
                    {formatBRL(bill.amountCents)} ·{" "}
                    {status(bill) === "paid"
                      ? "Paga"
                      : status(bill) === "late"
                        ? "Atrasada"
                        : "Pendente"}
                  </small>
                </span>
                <button
                  onClick={() => togglePaid(bill)}
                  className={`rounded-lg px-3 py-2 text-xs ${status(bill) === "paid" ? "bg-[var(--panel)]" : "primary"}`}
                >
                  {status(bill) === "paid" ? "Desfazer" : "Marcar paga"}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
function CardInvoicePreview({ data, tx }: any) {
  const cards = data.institutions.flatMap((institution: Institution) =>
    institution.cards.map((card) => ({ institution, card })),
  );
  const currentMonth = format(new Date(), "yyyy-MM");
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
          const available = Math.max(0, card.limit - current);
          return (
            <div className="py-3" key={card.id}>
              <div className="flex justify-between text-sm">
                <span>
                  {institution.name} · {card.name}
                </span>
                <b>
                  {formatBRL(current)} / {formatBRL(card.limit)}
                </b>
              </div>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-[var(--panel2)]">
                <span
                  className="block h-full bg-[var(--accent)]"
                  style={{
                    width: `${Math.min(100, (current / card.limit) * 100)}%`,
                  }}
                />
              </div>
              <p className="muted mt-2 text-xs">
                Disponível: {formatBRL(available)} · fecha dia{" "}
                {card.closingDay || "—"} · vence dia {card.dueDay || "—"}
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
function Launcher({ data, close, saved, createCategory, createInvestment }: any) {
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
    [showInvestment, setShowInvestment] = useState(false);
  const options = data.institutions.flatMap((i: Institution) => [
    ...i.accounts.map((a) => ({
      id: `account:${i.id}:${a.id}`,
      label: `${i.name} • ${a.name}`,
    })),
    ...i.cards.map((c) => ({
      id: `card:${i.id}:${c.id}`,
      label: `${i.name} • ${c.name || "Crédito"}`,
    })),
  ]);
  const categoryStep =
    k === "expense" || k === "income" || k === "investment" ? 1 : -1;
  const sourceStep = categoryStep + 1;
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
            : "Como você pagou?"
      : "Para qual conta foi?";
  const choose = (value: string) => {
    if (step === sourceStep) setSource(value);
    else setDest(value);
  };
  const valid = () => {
    if (step === 0) return Number(amount.replace(",", ".")) > 0;
    if (step === categoryStep) return Boolean(cat);
    if (step === sourceStep) return Boolean(source);
    if (step === destinationStep) return Boolean(dest) && dest !== source;
    return true;
  };
  const final = () =>
    saved([
      {
        id: crypto.randomUUID(),
        type: k === "salary" ? "income" : k,
        subtype: k,
        amountCents: Math.round(Number(amount.replace(",", ".")) * 100),
        category: cat || labels(k),
        account: source,
        destinationAccount: dest || undefined,
        date: new Date(`${date}T12:00:00`).toISOString(),
        description,
        attachmentUrl: attachmentUrl || undefined,
        tags,
        investmentId: k === "investment" ? investmentId : undefined,
        createdAt: new Date().toISOString(),
      },
    ]);
  const classifications =
    data.categories.length
        ? data.categories
        : defaults;
  if (!k)
    return (
      <Sheet close={close}>
        <b className="text-lg">Registrar movimentação</b>
        <p className="muted mt-1 text-sm">
          Escolha o que aconteceu com seu dinheiro.
        </p>
        <div className="mt-5 grid grid-cols-2 gap-2">
          {choices.map(([x, label, I]) => (
            <button
              onClick={() => {
                setK(x);
                setStep(0);
              }}
              className="panel rounded-xl p-4 text-left transition hover:ring-1 hover:ring-[var(--accent)]"
              key={label}
            >
              <I className="text-[var(--accent)]" size={20} />
              <b className="mt-3 block text-sm">{label}</b>
            </button>
          ))}
        </div>
      </Sheet>
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
        {options.length ? (
          options.map((x) => (
            <button
              onClick={() => choose(x.label)}
              className={`block w-full rounded-xl bg-[var(--panel2)] p-3 text-left text-sm transition hover:ring-1 hover:ring-[var(--accent)] ${source === x.label || dest === x.label ? "ring-1 ring-[var(--accent)]" : ""}`}
              key={x.id}
            >
              {x.label}
            </button>
          ))
        ) : (
          <Empty text="Cadastre uma conta ou cartão para continuar." />
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
          {formatBRL(Math.round(Number(amount.replace(",", ".")) * 100))}
        </b>
        <p className="muted mt-3 text-sm">{cat || labels(k)}</p>
        <p className="muted text-sm">
          {source}
          {dest && ` → ${dest}`}
        </p>
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
              <b>{i.name}</b>
              <p className="muted mt-1 text-sm">
                {i.accounts.map((x) => x.name).join(", ") || "Sem conta"}
              </p>
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
    </section>
  );
}
function Cards({ data, save, toast }: any) {
  const [adding, setAdding] = useState(false);
  const [institutionId, setInstitutionId] = useState("");
  const [nickname, setNickname] = useState("");
  const [limit, setLimit] = useState("");
  const [closingDay, setClosingDay] = useState("");
  const [dueDay, setDueDay] = useState("");

  const addCard = () => {
    if (!institutionId || !Number(limit.replace(",", "."))) return;
    const institutions = data.institutions.map((institution: Institution) =>
      institution.id === institutionId
        ? {
            ...institution,
            cards: [
              ...institution.cards,
              {
                id: crypto.randomUUID(),
                name: nickname.trim() || "Crédito",
                limit: Math.round(Number(limit.replace(",", ".")) * 100),
                closingDay: closingDay || undefined,
                dueDay: dueDay || undefined,
                bestPurchaseDay: bestPurchaseDay(closingDay)?.toString(),
              },
            ],
          }
        : institution,
    );
    save({ ...data, institutions });
    toast("Cartão criado com sucesso.");
    setNickname("");
    setLimit("");
    setClosingDay("");
    setDueDay("");
    setAdding(false);
  };

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
            </article>
          ))}
        </div>
      ) : (
        <Empty text="Você ainda não possui cartões cadastrados." />
      )}
      {data.institutions.length && adding ? (
        <Sheet close={() => setAdding(false)}>
          <section className="space-y-3">
            <b className="text-sm">Adicionar cartão</b>
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
              onClick={addCard}
              className="primary h-11 w-full rounded-xl text-sm"
            >
              Adicionar cartão
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
    </section>
  );
}
function Categories({ data, tx, month, save, toast }: any) {
  const [n, setN] = useState("");
  const [tag, setTag] = useState("");
  const [adding, setAdding] = useState(false);
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
            {x}
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
                #{item}
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
                onClick={() => {
                  save(
                    tx.filter(
                      (item: FinanceTransaction) => item.id !== selected.id,
                    ),
                  );
                  toast("Lançamento excluído.");
                  setSelected(null);
                }}
                className="rounded-xl px-4 py-3 text-sm text-[var(--danger)]"
              >
                Excluir
              </button>
            </div>
          </section>
        </Sheet>
      )}
    </section>
  );
}
function Settings({ theme, setTheme, data, tx, saveData, saveTx, toast }: any) {
  const syncEnabled = Boolean(getSupabaseBrowserClient());
  const exportBackup = () => {
    const blob = new Blob(
      [
        JSON.stringify(
          { exportedAt: new Date().toISOString(), data, transactions: tx },
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
      <Theme value={theme} change={setTheme} />
      <section className="panel mt-6 rounded-2xl p-5">
        <b>Seus dados</b>
        <p className="muted mt-1 text-sm">
          Exporte um backup completo ou importe lançamentos de uma planilha CSV
          separada por ponto e vírgula.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            onClick={exportBackup}
            className="rounded-xl bg-[var(--panel2)] px-4 py-3 text-sm"
          >
            Exportar backup JSON
          </button>
          <label className="primary cursor-pointer rounded-xl px-4 py-3 text-sm">
            Importar CSV
            <input
              onChange={(event) => importCsv(event.target.files?.[0])}
              className="hidden"
              type="file"
              accept=".csv,text/csv"
            />
          </label>
        </div>
      </section>
      <section className="panel mt-4 rounded-2xl p-5">
        <b>Privacidade</b>
        <p className="muted mt-1 text-sm">
          {syncEnabled
            ? "A sincronização segura está disponível para sessões autenticadas pelo Supabase."
            : "A sincronização entre dispositivos será ativada ao configurar as credenciais do Supabase. Até lá, use o backup JSON antes de trocar de dispositivo."}
        </p>
      </section>
    </section>
  );
}
