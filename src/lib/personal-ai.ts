import "server-only";

type Transaction = {
  type?: string;
  category?: string;
  account?: string;
  description?: string;
  amountCents?: number;
  date?: string;
};

type FinancialState = {
  data?: { goals?: unknown[]; budgets?: unknown[]; investments?: unknown[]; recurringBills?: unknown[] };
  transactions?: Transaction[];
};

function money(cents: number) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(cents / 100);
}

/** Limits the data sent to a provider to a compact, useful financial snapshot. */
export function financialSnapshot(rawState: unknown) {
  const state = (rawState || {}) as FinancialState;
  const transactions = Array.isArray(state.transactions) ? state.transactions : [];
  const recent = [...transactions]
    .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")))
    .slice(0, 30);
  const income = recent.filter((item) => item.type === "income").reduce((sum, item) => sum + (item.amountCents || 0), 0);
  const expenses = recent.filter((item) => item.type === "expense").reduce((sum, item) => sum + (item.amountCents || 0), 0);
  const investments = recent.filter((item) => item.type === "investment").reduce((sum, item) => sum + (item.amountCents || 0), 0);
  const categories = new Map<string, number>();
  recent.filter((item) => item.type === "expense").forEach((item) => categories.set(item.category || "Outros", (categories.get(item.category || "Outros") || 0) + (item.amountCents || 0)));
  const topCategories = [...categories.entries()].sort(([, a], [, b]) => b - a).slice(0, 6).map(([name, amount]) => `${name}: ${money(amount)}`);
  return {
    summary: { recentTransactions: recent.length, income: money(income), consumption: money(expenses), investments: money(investments), topCategories },
    goals: (state.data?.goals || []).slice(0, 8),
    budgets: (state.data?.budgets || []).slice(0, 8),
    investments: (state.data?.investments || []).slice(0, 8),
    recentTransactions: recent.map((item) => ({ type: item.type, category: item.category, description: item.description, amount: money(item.amountCents || 0), date: item.date, account: item.account })),
  };
}

export const personalAiInstruction = `Você é o assistente financeiro pessoal da VALURISE. Responda em português do Brasil, de forma objetiva, acolhedora e prática. Use somente o retrato financeiro fornecido nesta conversa; se faltar informação, diga isso claramente. Não invente transações, valores, rendimentos ou alertas. Não execute movimentações, transferências, compras, alterações de dados ou qualquer ação financeira. Não dê recomendação de investimento personalizada, jurídica, tributária ou de crédito; ofereça educação financeira geral e sugira um profissional quando apropriado. Trate dados financeiros como confidenciais e não peça senhas, API keys ou documentos.`;
