export const FINANCE_ICON_CATALOG = [
  { id: "home", label: "Moradia", group: "category", color: "#168d83" },
  { id: "transport", label: "Transporte", group: "category", color: "#6686c8" },
  { id: "food", label: "Alimentação", group: "category", color: "#d47c59" },
  { id: "health", label: "Saúde", group: "category", color: "#9b71bd" },
  { id: "education", label: "Educação", group: "category", color: "#ba963d" },
  { id: "utilities", label: "Serviços", group: "category", color: "#a87957" },
  { id: "shopping", label: "Compras", group: "category", color: "#c96f91" },
  { id: "travel", label: "Viagem", group: "category", color: "#5484b9" },
  { id: "communication", label: "Comunicação", group: "category", color: "#42889b" },
  { id: "leisure", label: "Lazer", group: "category", color: "#aa78bd" },
  { id: "family", label: "Família", group: "category", color: "#d17886" },
  { id: "pets", label: "Pets", group: "category", color: "#9a805e" },
  { id: "work", label: "Trabalho", group: "category", color: "#577b8e" },
  { id: "income", label: "Receita", group: "category", color: "#16866a" },
  { id: "investment", label: "Investimento", group: "category", color: "#4d8c83" },
  { id: "other", label: "Outros", group: "category", color: "#748191" },
  { id: "bank", label: "Banco", group: "financial", color: "#738293" },
  { id: "wallet", label: "Carteira", group: "financial", color: "#548276" },
  { id: "credit-card", label: "Cartão", group: "financial", color: "#6a7890" },
  { id: "transfer", label: "Transferência", group: "financial", color: "#607c8d" },
  { id: "bank-nubank", label: "Nubank", group: "bank", color: "#820ad1" },
  { id: "bank-itau", label: "Itaú", group: "bank", color: "#ec7000" },
  { id: "bank-bradesco", label: "Bradesco", group: "bank", color: "#cc092f" },
  { id: "bank-santander", label: "Santander", group: "bank", color: "#ec0000" },
  { id: "bank-inter", label: "Inter", group: "bank", color: "#ff7a00" },
  { id: "bank-c6", label: "C6 Bank", group: "bank", color: "#34383d" },
  { id: "bank-bb", label: "Banco do Brasil", group: "bank", color: "#174f9b" },
  { id: "bank-caixa", label: "Caixa", group: "bank", color: "#0873bc" },
  { id: "bank-picpay", label: "PicPay", group: "bank", color: "#11c76f" },
  { id: "bank-mercadopago", label: "Mercado Pago", group: "bank", color: "#009ee3" },
  { id: "bank-pagbank", label: "PagBank", group: "bank", color: "#00a868" },
  { id: "bank-neon", label: "Neon", group: "bank", color: "#009ee3" },
  { id: "bank-sicredi", label: "Sicredi", group: "bank", color: "#297c43" },
  { id: "bank-sicoob", label: "Sicoob", group: "bank", color: "#006b45" },
] as const;

export type FinanceIconId = (typeof FINANCE_ICON_CATALOG)[number]["id"];
export type FinanceIconGroup = (typeof FINANCE_ICON_CATALOG)[number]["group"];
export type FinanceIconOption = (typeof FINANCE_ICON_CATALOG)[number];

export const CATEGORY_ICON_OPTIONS = FINANCE_ICON_CATALOG.filter(
  (item) => item.group === "category",
);

const iconIds = new Set<string>(FINANCE_ICON_CATALOG.map((item) => item.id));

export function isFinanceIconId(value: unknown): value is FinanceIconId {
  return typeof value === "string" && iconIds.has(value);
}

function normalizeLabel(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const bankAliases: Array<[FinanceIconId, string[]]> = [
  ["bank-mercadopago", ["mercado pago", "mercadopago"]],
  ["bank-bb", ["banco do brasil", "banco brasil", "bb"]],
  ["bank-santander", ["santander"]],
  ["bank-bradesco", ["bradesco"]],
  ["bank-nubank", ["nubank", "nu bank", "nu"]],
  ["bank-itau", ["itau"]],
  ["bank-inter", ["banco inter", "inter"]],
  ["bank-c6", ["c6 bank", "c6"]],
  ["bank-caixa", ["caixa economica", "caixa"]],
  ["bank-picpay", ["picpay"]],
  ["bank-pagbank", ["pagbank", "pag seguro", "pagseguro"]],
  ["bank-neon", ["neon"]],
  ["bank-sicredi", ["sicredi"]],
  ["bank-sicoob", ["sicoob"]],
];

export function inferBankIconId(institutionName: string): FinanceIconId | undefined {
  const normalized = normalizeLabel(institutionName);
  const words = new Set(normalized.split(" "));
  return bankAliases.find(([, aliases]) =>
    aliases.some((alias) => {
      const normalizedAlias = normalizeLabel(alias);
      return normalizedAlias.includes(" ")
        ? normalized.includes(normalizedAlias)
        : words.has(normalizedAlias);
    }),
  )?.[0];
}

const categoryAliases: Array<[FinanceIconId, string[]]> = [
  ["utilities", ["agua", "luz", "energia", "internet", "telefone", "gas", "conta de"]],
  ["food", ["alimentacao", "mercado", "supermercado", "restaurante", "comida", "refeicao"]],
  ["transport", ["transporte", "gasolina", "combustivel", "uber", "onibus", "carro", "estacionamento"]],
  ["health", ["saude", "farmacia", "medico", "plano de saude", "academia"]],
  ["education", ["educacao", "escola", "curso", "faculdade", "livro"]],
  ["home", ["moradia", "casa", "aluguel", "condominio", "reforma"]],
  ["shopping", ["compras", "roupa", "vestuario", "eletronico"]],
  ["travel", ["viagem", "hospedagem", "passagem", "turismo"]],
  ["communication", ["comunicacao", "streaming", "assinatura", "software"]],
  ["leisure", ["lazer", "entretenimento", "cinema", "jogos", "hobby"]],
  ["family", ["familia", "crianca", "filhos", "pessoal"]],
  ["pets", ["pet", "pets", "veterinario", "animal"]],
  ["work", ["trabalho", "escritorio", "negocio"]],
  ["income", ["salario", "receita", "renda", "pagamento recebido"]],
  ["investment", ["investimento", "aporte", "aplicacao"]],
];

export function inferCategoryIconId(category: string): FinanceIconId {
  const normalized = normalizeLabel(category);
  const words = new Set(normalized.split(" "));
  return categoryAliases.find(([, aliases]) => aliases.some((alias) => {
    const normalizedAlias = normalizeLabel(alias);
    return normalizedAlias.includes(" ")
      ? normalized.includes(normalizedAlias)
      : words.has(normalizedAlias);
  }))?.[0] || "other";
}

export function resolveInstitutionIconId(institution: {
  name: string;
  iconId?: unknown;
}): FinanceIconId {
  return isFinanceIconId(institution.iconId)
    ? institution.iconId
    : inferBankIconId(institution.name) || "bank";
}

export function resolveCategoryIconId(
  category: string,
  overrides?: Record<string, unknown>,
): FinanceIconId {
  const override = overrides?.[category];
  return isFinanceIconId(override) && CATEGORY_ICON_OPTIONS.some((option) => option.id === override)
    ? override
    : inferCategoryIconId(category);
}
