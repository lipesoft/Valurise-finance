import { z } from "zod";

const MAX_BACKUP_BYTES = 10 * 1024 * 1024;
const MAX_TRANSACTIONS = 50_000;

const accountSchema = z.object({
  id: z.string(),
  name: z.string(),
  balance: z.number().finite(),
}).passthrough();

const institutionSchema = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string(),
  accounts: z.array(accountSchema),
  cards: z.array(z.object({
    id: z.string(),
    name: z.string(),
    limit: z.number().finite().nonnegative(),
    closingDay: z.string().optional(),
    dueDay: z.string().optional(),
    bestPurchaseDay: z.string().optional(),
  }).passthrough()),
}).passthrough();

const dataSchema = z.object({
  categories: z.array(z.string()).max(500),
  institutions: z.array(institutionSchema).max(500),
  investments: z.array(z.object({
    id: z.string(),
    name: z.string(),
    institution: z.string().optional(),
    assetClass: z.string().optional(),
    expectedAnnualRate: z.number().finite().optional(),
    contributedCents: z.number().int().nonnegative(),
    currentCents: z.number().int().nonnegative().optional(),
  }).passthrough()).max(500).optional(),
  budgets: z.array(z.object({
    id: z.string(),
    category: z.string(),
    limitCents: z.number().int().nonnegative(),
    month: z.string(),
  }).passthrough()).max(2_000).optional(),
  goals: z.array(z.object({
    id: z.string(),
    name: z.string(),
    targetCents: z.number().int().nonnegative(),
    currentCents: z.number().int().nonnegative(),
    targetDate: z.string().optional(),
    accountId: z.string().optional(),
    sharedGoalId: z.string().optional(),
  }).passthrough()).max(500).optional(),
  tags: z.array(z.string()).max(500).optional(),
  recurringBills: z.array(z.object({
    id: z.string(),
    name: z.string(),
    amountCents: z.number().int().nonnegative(),
    dueDay: z.number().int().min(1).max(31),
    category: z.string().optional(),
    account: z.string().optional(),
    frequency: z.enum(["monthly", "yearly"]),
    active: z.boolean(),
    paidMonth: z.string().optional(),
  }).passthrough()).max(2_000).optional(),
  activity: z.array(z.object({ id: z.string(), text: z.string(), date: z.string() }).passthrough()).max(5_000).optional(),
  monthlyReview: z.record(z.string(), z.array(z.string())).optional(),
  dashboardWidgets: z.array(z.object({ id: z.string(), visible: z.boolean() }).passthrough()).max(100).optional(),
  onboarded: z.boolean(),
}).passthrough();

const transactionSchema = z.object({
  id: z.string().min(1),
  type: z.enum(["income", "expense", "investment", "transfer"]),
  subtype: z.string().optional(),
  amountCents: z.number().int().nonnegative(),
  category: z.string(),
  account: z.string(),
  description: z.string().optional(),
  date: z.string().datetime({ offset: true }),
  createdAt: z.string().datetime({ offset: true }),
  destinationAccount: z.string().optional(),
  tags: z.array(z.string()).optional(),
  attachmentUrl: z.string().optional(),
  installment: z.object({ current: z.number().int().positive(), total: z.number().int().positive() })
    .refine((value) => value.current <= value.total, "Parcela atual não pode superar o total.")
    .optional(),
  investmentId: z.string().optional(),
}).passthrough();

const backupSchema = z.object({
  format: z.literal("valurise-backup").optional(),
  version: z.number().int().optional(),
  exportedAt: z.string().datetime({ offset: true }).optional(),
  data: dataSchema,
  transactions: z.array(transactionSchema).max(MAX_TRANSACTIONS),
}).passthrough();

export type ValuriseBackup<TData, TTransaction> = {
  format: "valurise-backup";
  version: 1;
  exportedAt: string;
  data: TData;
  transactions: TTransaction[];
};

export function createValuriseBackup<TData, TTransaction>(
  data: TData,
  transactions: TTransaction[],
  exportedAt = new Date().toISOString(),
): ValuriseBackup<TData, TTransaction> {
  return { format: "valurise-backup", version: 1, exportedAt, data, transactions };
}

export function parseValuriseBackup<TData, TTransaction>(contents: string) {
  if (new TextEncoder().encode(contents).byteLength > MAX_BACKUP_BYTES) {
    throw new Error("O arquivo excede o limite de 10 MB.");
  }

  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new Error("O arquivo não contém um JSON válido.");
  }

  const parsed = backupSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("Este arquivo não parece ser um backup válido da Valurise.");
  }
  if (parsed.data.format && parsed.data.version !== 1) {
    throw new Error("A versão deste backup não é compatível com esta Valurise.");
  }

  return parsed.data as { data: TData; transactions: TTransaction[]; exportedAt?: string };
}
