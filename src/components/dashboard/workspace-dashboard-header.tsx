"use client";

import { useEffect, useState } from "react";
import { addMonths, format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { StaggerItem } from "@/components/motion";
import type { WorkspaceSummary } from "@/lib/workspaces/types";

type WorkspaceDashboardHeaderProps = {
  workspace: WorkspaceSummary;
  userName: string;
  month: Date;
  setMonth: (month: Date) => void;
};

export function WorkspaceDashboardHeader({
  workspace,
  userName,
  month,
  setMonth,
}: WorkspaceDashboardHeaderProps) {
  const [greeting, setGreeting] = useState("Olá");

  useEffect(() => {
    if (workspace.type === "business") return;
    const hour = new Date().getHours();
    setGreeting(hour < 12 ? "Bom dia" : hour < 18 ? "Boa tarde" : "Boa noite");
  }, [workspace.type]);

  return (
    <>
      <StaggerItem>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          {workspace.type === "business"
            ? workspace.displayName
            : `${greeting}, ${userName}.`}
        </h1>
      </StaggerItem>
      <StaggerItem>
        <div className="mt-5 flex items-center justify-between">
          <button
            type="button"
            aria-label="Mês anterior"
            onClick={() => setMonth(addMonths(month, -1))}
            className="grid h-10 w-10 place-items-center rounded-xl hover:bg-[var(--panel2)]"
          >
            <ChevronLeft aria-hidden="true" />
          </button>
          <b className="capitalize">
            {format(month, "MMMM yyyy", { locale: ptBR })}
          </b>
          <button
            type="button"
            aria-label="Próximo mês"
            onClick={() => setMonth(addMonths(month, 1))}
            className="grid h-10 w-10 place-items-center rounded-xl hover:bg-[var(--panel2)]"
          >
            <ChevronRight aria-hidden="true" />
          </button>
        </div>
      </StaggerItem>
    </>
  );
}
