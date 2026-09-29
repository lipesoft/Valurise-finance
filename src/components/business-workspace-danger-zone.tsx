"use client";

import { AlertTriangle, LoaderCircle, Trash2, X } from "lucide-react";
import { useState } from "react";

type BusinessWorkspaceDangerZoneProps = {
  workspaceId: string;
  workspaceName: string;
  onDelete: (workspaceId: string, confirmationName: string) => Promise<void>;
};

function normalizeName(value: string) {
  return value.trim().normalize("NFC").toLocaleLowerCase("pt-BR");
}

export function BusinessWorkspaceDangerZone({ workspaceId, workspaceName, onDelete }: BusinessWorkspaceDangerZoneProps) {
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState(false);
  const confirmed = normalizeName(confirmation) === normalizeName(workspaceName);

  const confirmDeletion = async () => {
    if (!confirmed || deleting) return;
    setDeleting(true);
    setError("");
    try {
      await onDelete(workspaceId, confirmation.trim());
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível excluir esta empresa.");
      setDeleting(false);
    }
  };

  return <>
    <section aria-labelledby="business-danger-zone-title" className="mt-4 rounded-2xl border border-[var(--danger)]/30 bg-[var(--danger)]/[0.035] p-4 sm:p-5">
      <div className="flex items-start gap-3">
        <span aria-hidden="true" className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[var(--danger)]/10 text-[var(--danger)]"><AlertTriangle size={18}/></span>
        <div className="min-w-0 flex-1">
          <h2 id="business-danger-zone-title" className="font-semibold">Excluir empresa</h2>
          <p className="muted mt-1 max-w-2xl text-sm leading-6">Remove permanentemente esta empresa e os dados financeiros vinculados a ela. Seu espaço Pessoal, que foi criado primeiro, continua intacto.</p>
          <button type="button" onClick={() => { setConfirmation(""); setError(""); setOpen(true); }} className="mt-4 inline-flex min-h-10 items-center gap-2 rounded-xl border border-[var(--danger)]/45 px-3.5 text-sm font-medium text-[var(--danger)] transition-colors hover:bg-[var(--danger)]/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--danger)]">
            <Trash2 size={15}/> Excluir esta empresa
          </button>
        </div>
      </div>
    </section>

    {open && <div className="fixed inset-0 z-[100] grid place-items-end bg-black/65 p-0 backdrop-blur-sm sm:place-items-center sm:p-5" onMouseDown={(event) => { if (event.target === event.currentTarget && !deleting) setOpen(false); }}>
      <section role="dialog" aria-modal="true" aria-labelledby="delete-business-title" aria-describedby="delete-business-description" className="panel w-full max-w-lg rounded-t-3xl p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] shadow-2xl sm:rounded-3xl sm:p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3">
            <span aria-hidden="true" className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[var(--danger)]/10 text-[var(--danger)]"><Trash2 size={18}/></span>
            <div className="min-w-0"><p className="muted text-xs font-semibold uppercase tracking-[0.12em]">Ação permanente</p><h3 id="delete-business-title" className="mt-1 text-lg font-semibold">Excluir {workspaceName}?</h3></div>
          </div>
          <button type="button" aria-label="Fechar confirmação" disabled={deleting} onClick={() => setOpen(false)} className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[var(--panel2)] disabled:opacity-50"><X size={18}/></button>
        </div>
        <p id="delete-business-description" className="muted mt-4 text-sm leading-6">Esta ação apaga o cadastro da empresa, o perfil financeiro, lançamentos, contas, cartões, metas e demais dados vinculados ao espaço empresarial.</p>
        <p className="mt-3 rounded-xl bg-[var(--accent)]/8 p-3 text-sm leading-6"><b className="text-[var(--accent)]">Seu espaço Pessoal permanecerá intacto.</b> Após a exclusão, o Valurise voltará para ele.</p>
        <label className="mt-5 block text-sm font-medium">Para confirmar, digite <span className="text-[var(--danger)]">{workspaceName}</span>
          <input autoFocus value={confirmation} onChange={(event) => setConfirmation(event.target.value)} disabled={deleting} autoComplete="off" className="field mt-2" placeholder={workspaceName} aria-label={`Digite o nome da empresa ${workspaceName}`}/>
        </label>
        {error && <p role="alert" className="mt-3 rounded-xl border border-[var(--danger)]/30 bg-[var(--danger)]/10 p-3 text-sm leading-5 text-[var(--danger)]">{error}</p>}
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button type="button" disabled={deleting} onClick={() => setOpen(false)} className="min-h-11 rounded-xl bg-[var(--panel2)] px-4 text-sm disabled:opacity-50">Cancelar</button>
          <button type="button" disabled={!confirmed || deleting} onClick={() => void confirmDeletion()} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-[var(--danger)] px-4 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-45">
            {deleting ? <><LoaderCircle size={16} className="animate-spin"/> Excluindo…</> : <><Trash2 size={15}/> Confirmar exclusão definitiva</>}
          </button>
        </div>
      </section>
    </div>}
  </>;
}
