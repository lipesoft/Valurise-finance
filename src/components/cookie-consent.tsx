"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Cookie, X } from "lucide-react";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { legalVersions } from "@/lib/legal-content";

const STORAGE_KEY = "valurise:cookie-consent";
type Preference = "accepted" | "essential_only";
type SavedChoice = { preference: Preference; version: string };

function readChoice(): SavedChoice | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (!value) return null;
    const parsed = JSON.parse(value) as SavedChoice;
    return parsed.version === legalVersions.cookies ? parsed : null;
  } catch {
    return null;
  }
}

export function CookieConsent() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let disposed = false;
    const syncWithUser = async (userId: string) => {
      const supabase = getSupabaseBrowserClient();
      if (!supabase) return;
      const { data, error } = await supabase.from("user_consents")
        .select("cookie_preference, cookie_policy_version")
        .eq("user_id", userId).maybeSingle();
      if (disposed) return;
      if (!error && data?.cookie_policy_version === legalVersions.cookies && ["accepted", "essential_only"].includes(data.cookie_preference)) {
        const choice: SavedChoice = { preference: data.cookie_preference as Preference, version: legalVersions.cookies };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(choice));
        setOpen(false);
        return;
      }
      const local = readChoice();
      if (local) {
        const { error: saveError } = await supabase.from("user_consents").upsert({
          user_id: userId,
          cookie_preference: local.preference,
          cookie_policy_version: local.version,
          updated_at: new Date().toISOString(),
        }, { onConflict: "user_id" });
        if (disposed) return;
        if (!saveError) { setOpen(false); return; }
        setMessage("Sua escolha está salva neste navegador, mas não sincronizou com sua conta. Você pode tentar novamente.");
        setOpen(true);
        return;
      }
      setOpen(!local);
    };

    const supabase = getSupabaseBrowserClient();
    const local = readChoice();
    setOpen(!local);
    if (supabase) {
      void supabase.auth.getUser().then(({ data }) => {
        if (data.user) return syncWithUser(data.user.id);
      });
      const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
        if (session?.user) window.setTimeout(() => void syncWithUser(session.user.id), 0);
      });
      return () => { disposed = true; subscription.unsubscribe(); };
    }
    const onOpen = () => { setMessage(""); setOpen(true); };
    window.addEventListener("valurise:manage-cookie-consent", onOpen);
    return () => { disposed = true; window.removeEventListener("valurise:manage-cookie-consent", onOpen); };
  }, []);

  // Settings can reopen the manager even when a choice was already saved.
  useEffect(() => {
    const onOpen = () => { setMessage(""); setOpen(true); };
    window.addEventListener("valurise:manage-cookie-consent", onOpen);
    return () => window.removeEventListener("valurise:manage-cookie-consent", onOpen);
  }, []);

  const choose = async (preference: Preference) => {
    const choice: SavedChoice = { preference, version: legalVersions.cookies };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(choice));
    setBusy(true);
    setMessage("");
    const supabase = getSupabaseBrowserClient();
    const { data: auth } = await supabase?.auth.getUser() || {};
    if (auth?.user && supabase) {
      const { error } = await supabase.from("user_consents").upsert({
        user_id: auth.user.id,
        cookie_preference: preference,
        cookie_policy_version: legalVersions.cookies,
        updated_at: new Date().toISOString(),
      }, { onConflict: "user_id" });
      if (error) {
        setBusy(false);
        setMessage("A escolha ficou salva neste navegador, mas não sincronizou com sua conta. Tente novamente.");
        return;
      }
    }
    setBusy(false);
    setOpen(false);
  };

  if (!open) return null;
  return (
    <section aria-labelledby="cookie-consent-title" className="cookie-consent panel" role="region">
      <div className="flex items-start gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[var(--accent)]/12 text-[var(--accent)]"><Cookie size={19} aria-hidden="true" /></span>
        <div className="min-w-0 flex-1">
          <h2 id="cookie-consent-title" className="text-sm font-semibold">Privacidade e cookies</h2>
          <p className="muted mt-1 text-xs leading-5">Usamos armazenamento essencial para manter sua sessão e lembrar preferências. Não usamos rastreamento publicitário. <Link href="/cookies" className="text-[var(--accent)] underline underline-offset-2">Saiba mais</Link></p>
          {message && <p role="alert" className="mt-2 text-xs text-[var(--danger)]">{message}</p>}
        </div>
        <button type="button" className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[var(--panel2)]" aria-label="Recusar cookies opcionais e fechar aviso" onClick={() => void choose("essential_only")}><X size={16} /></button>
      </div>
      <div className="mt-4 flex flex-wrap gap-2 sm:justify-end">
        <button disabled={busy} type="button" className="min-h-11 rounded-xl bg-[var(--panel2)] px-3 text-xs font-medium" onClick={() => void choose("essential_only")}>Apenas necessários</button>
        <button disabled={busy} type="button" className="primary min-h-11 rounded-xl px-3 text-xs font-semibold" onClick={() => void choose("accepted")}>{busy ? "Salvando…" : "Aceitar preferências"}</button>
      </div>
    </section>
  );
}
