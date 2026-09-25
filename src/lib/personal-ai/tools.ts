import "server-only";

import { tool } from "ai";
import { z } from "zod";
import { accountBalance } from "@/lib/finance";
import { formatValData } from "@/lib/personal-ai";
import { isRecurringBillPaidInMonth, isRecurringBillScheduledInMonth, recurringBillDueDay } from "@/lib/recurring-bills";

type Row = Record<string, unknown>;
type FinancialState = { data: Row; transactions: Row[] };

function asRow(value: unknown): Row { return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {}; }
function rows(value: unknown): Row[] { return Array.isArray(value) ? value.filter((item): item is Row => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : []; }
function safeCents(value: unknown) { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null; }
function safeText(value: unknown, fallback = "Não informado", max = 80) {
  if (typeof value !== "string") return fallback;
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
  return text || fallback;
}
function transactionDate(value: unknown) {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
function monthRange(month: string) {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  if (!match) return null;
  const year = Number(match[1]); const monthIndex = Number(match[2]) - 1;
  return { start: new Date(year, monthIndex, 1), end: new Date(year, monthIndex + 1, 1) };
}
function defaultMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}
function inRange(value: unknown, range: { start: Date; end: Date }) {
  const date = transactionDate(value);
  return date !== null && date >= range.start && date < range.end;
}
function validTransaction(row: Row) {
  return safeCents(row.amountCents) !== null && transactionDate(row.date) !== null;
}

export function createPersonalFinanceTools(rawState: unknown) {
  const root = asRow(rawState);
  const data = asRow(root.data);
  const transactions = rows(root.transactions).filter(validTransaction);
  const state: FinancialState = { data, transactions };

  return {
    getFinancialSummary: tool({
      description: "Retorna um resumo determinístico de receitas, despesas e aportes do mês atual ou anterior da conta autenticada. Não inclui dados de outras pessoas.",
      inputSchema: z.object({ period: z.enum(["current_month", "last_month"]).default("current_month") }).strict(),
      execute: async ({ period }) => {
        const current = monthRange(defaultMonth())!;
        const range = period === "current_month"
          ? current
          : { start: new Date(current.start.getFullYear(), current.start.getMonth() - 1, 1), end: current.start };
        const items = state.transactions.filter((item) => inRange(item.date, range));
        const sum = (type: string) => items.filter((item) => item.type === type).reduce((total, item) => total + Number(item.amountCents), 0);
        const expenses = items.filter((item) => item.type === "expense");
        const byCategory = new Map<string, number>();
        expenses.forEach((item) => {
          const category = safeText(item.category, "Outros", 60);
          byCategory.set(category, (byCategory.get(category) || 0) + Number(item.amountCents));
        });
        return formatValData({
          period: `${range.start.getFullYear()}-${String(range.start.getMonth() + 1).padStart(2, "0")}`,
          incomeCents: sum("income"), expenseCents: sum("expense"), investmentContributionCents: sum("investment"),
          netCashFlowCents: sum("income") - sum("expense") - sum("investment"),
          expenseCategories: [...byCategory].map(([category, amountCents]) => ({ category, amountCents })).sort((a, b) => b.amountCents - a.amountCents).slice(0, 6),
          transactionCount: items.length,
          calculation: "Valores somados dos lançamentos válidos da conta no período; aportes separados de consumo.",
        });
      },
    }),
    getTransactions: tool({
      description: "Consulta uma lista limitada de lançamentos da própria conta, com filtros opcionais. Mostra no máximo 12 resultados e nunca lê anexos ou dados de outros usuários.",
      inputSchema: z.object({
        period: z.enum(["current_month", "last_month", "last_30_days"]).default("last_30_days"),
        category: z.string().max(60).default(""),
        searchTerm: z.string().max(60).default(""),
        type: z.enum(["income", "expense", "investment", "transfer", "all"]).default("all"),
      }).strict(),
      execute: async ({ period, category, searchTerm, type }) => {
        const current = monthRange(defaultMonth())!;
        const range = period === "current_month" ? current : period === "last_month"
          ? { start: new Date(current.start.getFullYear(), current.start.getMonth() - 1, 1), end: current.start }
          : { start: new Date(Date.now() - 30 * 86400_000), end: new Date(Date.now() + 60_000) };
        const categoryNeedle = category?.trim().toLocaleLowerCase("pt-BR");
        const searchNeedle = searchTerm?.trim().toLocaleLowerCase("pt-BR");
        const result = state.transactions.filter((item) => inRange(item.date, range)
          && (type === "all" || item.type === type)
          && (!categoryNeedle || safeText(item.category, "Outros", 60).toLocaleLowerCase("pt-BR").includes(categoryNeedle))
          && (!searchNeedle || `${safeText(item.description, "", 90)} ${safeText(item.category, "", 60)}`.toLocaleLowerCase("pt-BR").includes(searchNeedle)))
          .sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 12)
          .map((item) => ({
            type: item.type,
            description: safeText(item.description, safeText(item.category, "Movimentação", 60), 90),
            category: safeText(item.category, "Outros", 60),
            amountCents: Number(item.amountCents),
            date: transactionDate(item.date)?.toISOString() || null,
            account: safeText(item.account, "Não informada", 80),
            installment: item.installment && typeof item.installment === "object" ? item.installment : undefined,
          }));
        return formatValData({ period, count: result.length, transactions: result });
      },
    }),
    getCategorySpending: tool({
      description: "Calcula despesas por categoria em um dos dois meses mais recentes.",
      inputSchema: z.object({ period: z.enum(["current_month", "last_month"]).default("current_month"), category: z.string().max(60).default("") }).strict(),
      execute: async ({ period, category }) => {
        const current = monthRange(defaultMonth())!;
        const range = period === "current_month" ? current : { start: new Date(current.start.getFullYear(), current.start.getMonth() - 1, 1), end: current.start };
        const needle = category?.trim().toLocaleLowerCase("pt-BR");
        const sums = new Map<string, number>();
        state.transactions.filter((item) => item.type === "expense" && inRange(item.date, range)
          && (!needle || safeText(item.category, "Outros", 60).toLocaleLowerCase("pt-BR").includes(needle)))
          .forEach((item) => { const name = safeText(item.category, "Outros", 60); sums.set(name, (sums.get(name) || 0) + Number(item.amountCents)); });
        const categories = [...sums].map(([name, amountCents]) => ({ name, amountCents })).sort((a, b) => b.amountCents - a.amountCents);
        return formatValData({ period, totalExpenseCents: categories.reduce((total, item) => total + item.amountCents, 0), categories: categories.slice(0, 12) });
      },
    }),
    getBudgetStatus: tool({
      description: "Compara limites de orçamento com despesas registradas no mês solicitado; não estima valores ausentes.",
      inputSchema: z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).default(defaultMonth()) }).strict(),
      execute: async ({ month }) => {
        const range = monthRange(month);
        if (!range) return formatValData({ error: "Mês inválido." });
        const spent = new Map<string, number>();
        state.transactions.filter((item) => item.type === "expense" && inRange(item.date, range))
          .forEach((item) => { const category = safeText(item.category, "Outros", 60); spent.set(category, (spent.get(category) || 0) + Number(item.amountCents)); });
        const budgets = rows(data.budgets).filter((item) => item.month === month && safeCents(item.limitCents) !== null)
          .slice(0, 20).map((item) => {
            const category = safeText(item.category, "Categoria", 60);
            const limitCents = Number(item.limitCents); const usedCents = spent.get(category) || 0;
            return { category, month, limitCents, usedCents, remainingCents: limitCents - usedCents, percentUsed: limitCents ? Math.round(usedCents / limitCents * 100) : null };
          });
        return formatValData({ month, budgets, budgetCount: budgets.length });
      },
    }),
    getGoals: tool({
      description: "Lista metas da conta com progresso e valor restante calculados a partir dos dados cadastrados.",
      inputSchema: z.object({}).strict(),
      execute: async () => {
        const goals = rows(data.goals).slice(0, 12).flatMap((item) => {
          const targetCents = safeCents(item.targetCents); const currentCents = safeCents(item.currentCents);
          if (targetCents === null || currentCents === null) return [];
          return [{ name: safeText(item.name, "Meta", 80), targetCents, currentCents,
            remainingCents: Math.max(0, targetCents - currentCents),
            progressPercent: targetCents ? Math.min(100, Math.round(currentCents / targetCents * 100)) : null,
            targetDate: typeof item.targetDate === "string" ? item.targetDate.slice(0, 10) : null }];
        });
        return formatValData({ count: goals.length, goals });
      },
    }),
    getInvestments: tool({
      description: "Lista investimentos cadastrados. Aporte e valor atual permanecem separados; resultado é atual menos aportado e só é calculado quando o valor atual existe.",
      inputSchema: z.object({}).strict(),
      execute: async () => {
        const investments = rows(data.investments).slice(0, 12).flatMap((item) => {
          const contributedCents = safeCents(item.contributedCents);
          if (contributedCents === null) return [];
          const currentCents = safeCents(item.currentCents);
          const resultCents = currentCents === null ? null : currentCents - contributedCents;
          return [{ name: safeText(item.name, "Investimento", 80), institution: safeText(item.institution, "Não informada", 60),
            assetClass: safeText(item.assetClass, "Não informada", 40), contributedCents, currentCents, resultCents,
            returnPercent: currentCents === null || contributedCents === 0 ? null : Number((resultCents! / contributedCents * 100).toFixed(2)) }];
        });
        return formatValData({ count: investments.length, investments });
      },
    }),
    getAccounts: tool({
      description: "Lista contas do próprio usuário e calcula o saldo com as regras atuais do Valurise, incluindo transferências e aportes como saídas da conta de origem.",
      inputSchema: z.object({}).strict(),
      execute: async () => {
        const institutions = rows(data.institutions).slice(0, 20);
        const accounts = institutions.flatMap((institution) => rows(institution.accounts).slice(0, 20).flatMap((account) => {
          const initial = safeCents(account.balance);
          if (initial === null) return [];
          const label = `${safeText(institution.name, "Instituição", 60)} • ${safeText(account.name, "Conta", 60)}`;
          const ledger = state.transactions.map((item) => ({
            type: item.type,
            amountCents: Number(item.amountCents),
            account: item.account,
            destinationAccount: item.destinationAccount,
            date: item.date,
          })) as Parameters<typeof accountBalance>[2];
          return [{ name: label, balanceCents: accountBalance(initial, label, ledger) }];
        }));
        return formatValData({ count: accounts.length, accounts });
      },
    }),
    getCreditCards: tool({
      description: "Lista cartões registrados, limite, fechamento, vencimento e compras registradas no mês. Não confunda compras do mês com o total de uma fatura em aberto.",
      inputSchema: z.object({}).strict(),
      execute: async () => {
        const currentRange = monthRange(defaultMonth())!;
        const cards = rows(data.institutions).flatMap((institution) => rows(institution.cards).map((card) => {
          const cardLabel = `${safeText(institution.name, "Instituição", 60)} • ${safeText(card.name, "Crédito", 60)}`;
          const limitCents = safeCents(card.limit);
          const registeredMonthSpendCents = state.transactions
            .filter((item) => item.type === "expense" && item.account === cardLabel && inRange(item.date, currentRange))
            .reduce((total, item) => total + Number(item.amountCents), 0);
          return {
            name: cardLabel,
            limitCents,
            closingDay: safeText(card.closingDay, "Não informado", 2),
            dueDay: safeText(card.dueDay, "Não informado", 2),
            bestPurchaseDay: safeText(card.bestPurchaseDay, "Não informado", 2),
            registeredMonthSpendCents,
            note: "O gasto é a soma das compras lançadas no mês, não representa necessariamente o saldo total da fatura.",
          };
        }));
        return formatValData({ month: defaultMonth(), count: cards.length, cards: cards.slice(0, 20) });
      },
    }),
    getRecurringBills: tool({
      description: "Lista contas recorrentes e status do vencimento do mês com base na data local e no campo de pagamento registrado.",
      inputSchema: z.object({}).strict(),
      execute: async () => {
        const now = new Date();
        const month = defaultMonth();
        const bills = rows(data.recurringBills).filter((item) => item.active === true).slice(0, 30).flatMap((item) => {
          const amountCents = safeCents(item.amountCents);
          const dueDay = Number(item.dueDay);
          if (amountCents === null || !Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31) return [];
          const schedule = {
            active: item.active === true,
            dueDay,
            frequency: item.frequency === "once" || item.frequency === "yearly" ? item.frequency : "monthly",
            startMonth: typeof item.startMonth === "string" ? item.startMonth : undefined,
            paidMonth: typeof item.paidMonth === "string" ? item.paidMonth : undefined,
            paidMonths: Array.isArray(item.paidMonths) ? item.paidMonths.filter((value): value is string => typeof value === "string") : [],
          } as const;
          if (!isRecurringBillScheduledInMonth(schedule, month)) return [];
          const effectiveDueDay = recurringBillDueDay(schedule, month);
          const status = isRecurringBillPaidInMonth(schedule, month) ? "pago" : effectiveDueDay < now.getDate() ? "atrasado" : "pendente";
          return [{ name: safeText(item.name, "Conta recorrente", 80), amountCents, dueDay: effectiveDueDay, status,
            category: safeText(item.category, "Não informada", 60),
            frequency: schedule.frequency === "yearly" ? "anual" : schedule.frequency === "once" ? "uma vez" : "mensal" }];
        });
        return formatValData({ month, count: bills.length, recurringBills: bills });
      },
    }),
  };
}
