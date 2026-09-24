import "server-only";

import { tool } from "ai";
import { z } from "zod";
import { formatValData } from "@/lib/personal-ai";

export type PersonalAiTransactionDraft = {
  type: "income" | "expense";
  amountCents: number;
  category: string;
  account: string;
  description: string;
  date: string;
};

type Row = Record<string, unknown>;
const asRow = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.filter((item): item is Row => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
const text = (value: unknown, max: number) => typeof value === "string"
  ? value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max)
  : "";

function allowedDraftValues(rawState: unknown) {
  const data = asRow(asRow(rawState).data);
  const categories = [...new Set(rowsToStrings(data.categories).map((item) => text(item, 80)).filter(Boolean))];
  const accounts = rows(data.institutions).flatMap((institution) => {
    const institutionName = text(institution.name, 60);
    return rows(institution.accounts).flatMap((account) => {
      const accountName = text(account.name, 60);
      return institutionName && accountName ? [`${institutionName} • ${accountName}`] : [];
    });
  });
  return { categories, accounts: [...new Set(accounts)] };
}

function rowsToStrings(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function validatePersonalAiTransactionDraft(value: unknown, rawState: unknown): PersonalAiTransactionDraft {
  const schema = z.object({
    type: z.enum(["income", "expense"]),
    amountCents: z.number().int().positive().max(100_000_000_000),
    category: z.string().trim().min(1).max(80),
    account: z.string().trim().min(1).max(140),
    description: z.string().trim().min(1).max(140),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }).strict();
  const parsed = schema.parse(value);
  const parsedDate = new Date(`${parsed.date}T00:00:00.000Z`);
  if (Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== parsed.date) {
    throw new Error("A data proposta não é válida.");
  }
  const today = new Date();
  const todayString = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  if (parsed.date > todayString) throw new Error("Só posso propor lançamentos com data de hoje ou anterior.");

  const allowed = allowedDraftValues(rawState);
  if (!allowed.categories.includes(parsed.category)) throw new Error("A categoria precisa existir na sua conta.");
  if (!allowed.accounts.includes(parsed.account)) throw new Error("A conta precisa existir na sua conta.");
  return { ...parsed, category: text(parsed.category, 80), account: text(parsed.account, 140), description: text(parsed.description, 140) || parsed.category };
}

export function createPersonalAiTransactionProposalTool(
  rawState: unknown,
  createProposal: (draft: PersonalAiTransactionDraft) => Promise<{ id: string; expiresAt: string }>,
) {
  const { categories, accounts } = allowedDraftValues(rawState);
  return tool({
    description: "Prepara UMA proposta de receita ou despesa comum para revisão. Nunca grava o lançamento. Use somente quando o usuário pedir explicitamente para registrar um recebimento ou gasto. Não use para transferências, cartão, parcelas, aportes, investimentos, metas, edição ou exclusão. A pessoa verá os dados exatos e precisará confirmar no aplicativo.",
    inputSchema: z.object({
      type: z.enum(["income", "expense"]).describe("Tipo solicitado: receita ou despesa."),
      amountCents: z.number().int().positive().max(100_000_000_000).describe("Valor em centavos inteiros."),
      category: z.string().trim().min(1).max(80).describe(`Uma categoria existente. Opções: ${categories.slice(0, 80).join(" | ") || "nenhuma"}`),
      account: z.string().trim().min(1).max(140).describe(`Uma conta corrente existente; não usar cartão. Opções: ${accounts.slice(0, 80).join(" | ") || "nenhuma"}`),
      description: z.string().trim().min(1).max(140),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Data no formato YYYY-MM-DD; não pode ser futura."),
    }).strict(),
    execute: async (input) => {
      const draft = validatePersonalAiTransactionDraft(input, rawState);
      const proposal = await createProposal(draft);
      return formatValData({
        proposalId: proposal.id,
        expiresAt: proposal.expiresAt,
        status: "aguardando confirmação explícita no aplicativo",
        draft,
        warning: "Não foi salvo. Nunca diga que a movimentação foi registrada antes da confirmação do usuário.",
      });
    },
  });
}
