"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Building2, Check, ChevronDown, Plus, UserRound } from "lucide-react";
import type { WorkspaceSummary } from "@/lib/workspaces/types";

type WorkspaceSwitcherProps = {
  workspace: WorkspaceSummary;
  workspaces: WorkspaceSummary[];
  onSwitchWorkspace: (workspaceId: string) => void;
  onCreateWorkspace: () => void;
};

export function WorkspaceSwitcher({ workspace, workspaces, onSwitchWorkspace, onCreateWorkspace }: WorkspaceSwitcherProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const closeOnOutsidePress = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };

    document.addEventListener("pointerdown", closeOnOutsidePress);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePress);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  useEffect(() => {
    if (open) menuRef.current?.querySelector<HTMLButtonElement>("[role^='menuitem']")?.focus();
  }, [open]);

  const handleMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("[role^='menuitem']") || []);
    if (!items.length) return;
    event.preventDefault();
    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
    const nextIndex = event.key === "Home" ? 0
      : event.key === "End" ? items.length - 1
        : (currentIndex + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[nextIndex].focus();
  };

  const isPersonal = workspace.type === "personal";
  const triggerLabel = isPersonal ? "Pessoal" : workspace.displayName;

  return (
    <div ref={rootRef} className="relative min-w-0">
      <button
        ref={triggerRef}
        type="button"
        aria-label="Alternar espaço financeiro"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? "workspace-switcher-menu" : undefined}
        title={`Espaço ativo: ${isPersonal ? "Pessoal" : "Empresa"} · ${workspace.displayName}`}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown") return;
          event.preventDefault();
          setOpen(true);
        }}
        className="flex h-11 min-w-0 max-w-[min(9rem,40vw)] items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--panel2)] px-3 text-sm font-medium transition-colors hover:bg-[var(--panel)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
      >
        <span className="truncate">{triggerLabel}</span>
        <ChevronDown aria-hidden="true" size={15} className={`shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div
          ref={menuRef}
          id="workspace-switcher-menu"
          role="menu"
          aria-label="Espaços financeiros"
          onKeyDown={handleMenuKeyDown}
          onBlur={(event) => {
            if (!rootRef.current?.contains(event.relatedTarget as Node | null)) setOpen(false);
          }}
          className="absolute left-0 top-[calc(100%+0.5rem)] z-[60] w-[min(18rem,calc(100vw-1.5rem))] rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-1.5 shadow-2xl"
        >
          <p className="muted px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.12em]">Alternar espaço</p>
          <div className="max-h-[min(60vh,24rem)] overflow-y-auto">
            {workspaces.map((item) => {
              const selected = item.id === workspace.id;
              const personal = item.type === "personal";
              const ItemIcon = personal ? UserRound : Building2;
              return (
                <button
                  key={item.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  tabIndex={-1}
                  onClick={() => {
                    setOpen(false);
                    if (!selected) onSwitchWorkspace(item.id);
                  }}
                  className="flex min-h-14 w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-[var(--panel2)] focus-visible:bg-[var(--panel2)] focus-visible:outline-none"
                >
                  <span aria-hidden="true" className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-[var(--panel2)] text-[var(--accent)]">
                    <ItemIcon size={17} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold">{personal ? "Pessoal" : item.displayName}</span>
                    <span className="muted block truncate text-xs">{personal ? item.displayName : "Espaço empresarial"}</span>
                  </span>
                  {selected && <Check aria-hidden="true" size={17} className="shrink-0 text-[var(--accent)]" />}
                </button>
              );
            })}
          </div>
          <div className="my-1.5 border-t border-[var(--border)]" />
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            aria-label="Criar espaço empresarial"
            onClick={() => {
              setOpen(false);
              onCreateWorkspace();
            }}
            className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-sm font-medium text-[var(--accent)] transition-colors hover:bg-[var(--panel2)] focus-visible:bg-[var(--panel2)] focus-visible:outline-none"
          >
            <Plus aria-hidden="true" size={17} />
            Criar espaço empresarial
          </button>
        </div>
      )}
    </div>
  );
}
