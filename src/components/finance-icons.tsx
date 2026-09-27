"use client";

import {
  ArrowLeftRight,
  Baby,
  Banknote,
  Briefcase,
  CarFront,
  ChartNoAxesCombined,
  CircleHelp,
  CreditCard,
  GraduationCap,
  HeartPulse,
  House,
  Landmark,
  Lightbulb,
  Music,
  PawPrint,
  Plane,
  ShoppingBag,
  Utensils,
  Wallet,
  Wifi,
  type LucideIcon,
} from "lucide-react";
import {
  FINANCE_ICON_CATALOG,
  inferBankIconId,
  type FinanceIconId,
  type FinanceIconOption,
  isFinanceIconId,
} from "@/lib/finance-icons";

const pictograms: Partial<Record<FinanceIconId, LucideIcon>> = {
  home: House,
  transport: CarFront,
  food: Utensils,
  health: HeartPulse,
  education: GraduationCap,
  utilities: Lightbulb,
  shopping: ShoppingBag,
  travel: Plane,
  communication: Wifi,
  leisure: Music,
  family: Baby,
  pets: PawPrint,
  work: Briefcase,
  income: Banknote,
  investment: ChartNoAxesCombined,
  other: CircleHelp,
  bank: Landmark,
  wallet: Wallet,
  "credit-card": CreditCard,
  transfer: ArrowLeftRight,
};

const bankMarks: Partial<Record<FinanceIconId, { label: string; color: string; mark: string }>> = {
  "bank-itau": { label: "Itaú", color: "#ec7000", mark: "itaú" },
  "bank-bradesco": { label: "Bradesco", color: "#cc092f", mark: "br" },
  "bank-santander": { label: "Santander", color: "#ec0000", mark: "S" },
  "bank-inter": { label: "Inter", color: "#ff7a00", mark: "inter" },
  "bank-c6": { label: "C6 Bank", color: "#34383d", mark: "C6" },
  "bank-bb": { label: "Banco do Brasil", color: "#174f9b", mark: "BB" },
  "bank-caixa": { label: "Caixa", color: "#0873bc", mark: "CX" },
  "bank-mercadopago": { label: "Mercado Pago", color: "#009ee3", mark: "MP" },
  "bank-pagbank": { label: "PagBank", color: "#00a868", mark: "P" },
  "bank-neon": { label: "Neon", color: "#009ee3", mark: "neon" },
  "bank-sicredi": { label: "Sicredi", color: "#297c43", mark: "Si" },
  "bank-sicoob": { label: "Sicoob", color: "#006b45", mark: "S" },
};

function BankMark({ iconId, size }: { iconId: FinanceIconId; size: number }) {
  if (iconId === "bank-nubank") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path fill="#820ad1" d="M7.2795 5.4336c-1.1815 0-2.1846.4628-2.9432 1.252h-.002c-.0541-.0022-.1074-.002-.162-.002-1.5436 0-2.9925.8835-3.699 2.2559-.3088.5996-.4234 1.2442-.459 1.9003-.0321.589 0 1.1863 0 1.7696v5.6523H3.184s.0022-2.784 0-5.1777c-.0014-1.6112-.0118-3.0471 0-3.3418.056-1.3937.4372-2.3053 1.1484-3.0508 2.3585.0018 3.8852 1.6091 3.9705 4.168.0196.5874.0254 3.7304.0254 3.7304v3.672h3.1678v-4.965c0-1.5007.0127-2.8006-.0918-3.6952-.292-2.5-1.821-4.168-4.1248-4.168zm8.3903.3008l-3.166.0039v4.9648c0 1.5009-.0127 2.8007.0919 3.6953.2921 2.5001 1.821 4.168 4.1248 4.168 1.1815 0 2.1846-.4628 2.9432-1.252.0003-.0003.0016.0004.002 0 .0542.0023.1093.002.164.002 1.5435 0 2.9905-.8835 3.6971-2.2558.3088-.5997.4233-1.2442.459-1.9004.032-.5889 0-1.1862 0-1.7695V5.7383H20.816s-.0022 2.784 0 5.1777c.0015 1.6113.0119 3.047 0 3.3418-.056 1.3935-.4372 2.3053-1.1483 3.0508-2.3586-.0018-3.8853-1.6091-3.9706-4.168-.0196-.5874-.0273-2.0437-.0273-3.7324Z" />
      </svg>
    );
  }

  if (iconId === "bank-picpay") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path fill="#11c76f" d="M16.463 1.587v7.537H24V1.587zm1.256 1.256h5.025v5.025h-5.025zm1.256 1.256v2.513h2.513V4.099zM3.77 5.355V8.53h3.376c2.142 0 3.358 1.04 3.358 2.939 0 1.947-1.216 3.011-3.358 3.011H3.769V8.53H0v13.884h3.769v-4.76h3.57c4.333 0 6.815-2.352 6.815-6.32 0-3.771-2.482-5.978-6.814-5.978Z" />
      </svg>
    );
  }

  const mark = bankMarks[iconId];
  if (mark) {
    const textSize = mark.mark.length > 3 ? 8 : mark.mark.length > 2 ? 9 : 12;
    return (
      <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
        <rect x="1" y="1" width="30" height="30" rx="9" fill={mark.color} />
        <text x="16" y="20" textAnchor="middle" fill="white" fontSize={textSize} fontWeight="700" fontFamily="Arial, sans-serif">{mark.mark}</text>
      </svg>
    );
  }

  return <span className="grid h-full w-full place-items-center rounded-lg" style={{ backgroundColor: "var(--panel2)" }}><Landmark size={Math.max(16, size * 0.62)} aria-hidden="true" /></span>;
}

export function FinanceIconBadge({
  iconId,
  institutionName,
  fallbackIconId = "other",
  size = 40,
  className = "",
}: {
  iconId?: unknown;
  institutionName?: string;
  fallbackIconId?: FinanceIconId;
  size?: number;
  className?: string;
}) {
  const resolvedId = isFinanceIconId(iconId)
    ? iconId
    : institutionName
      ? inferBankIconId(institutionName) || fallbackIconId
      : fallbackIconId;
  const option = FINANCE_ICON_CATALOG.find((item) => item.id === resolvedId);
  const bank = resolvedId.startsWith("bank-");
  const Icon = pictograms[resolvedId] || Landmark;
  const brandColor = option?.color || "#748191";

  return (
    <span
      className={`inline-grid shrink-0 place-items-center overflow-hidden rounded-xl ${className}`}
      style={{ width: size, height: size, color: brandColor, backgroundColor: `${brandColor}18` }}
      data-finance-icon={resolvedId}
      aria-hidden="true"
    >
      {bank ? <BankMark iconId={resolvedId} size={Math.max(22, size - 8)} /> : <Icon size={Math.round(size * 0.48)} strokeWidth={1.8} />}
    </span>
  );
}

export function FinanceIconPicker({
  value = "",
  onChange,
  collection = "all",
  label,
  autoIconId = "other",
  autoLabel = "Automático",
}: {
  value?: FinanceIconId | "";
  onChange: (value: FinanceIconId | "") => void;
  collection?: "all" | "category";
  label: string;
  autoIconId?: FinanceIconId;
  autoLabel?: string;
}) {
  const options: readonly FinanceIconOption[] = collection === "category"
    ? FINANCE_ICON_CATALOG.filter((option) => option.group === "category")
    : FINANCE_ICON_CATALOG;

  return (
    <fieldset className="min-w-0 space-y-2">
      <legend className="text-sm font-medium">{label}</legend>
      <p className="muted text-xs leading-5">Você pode trocar depois. O automático reconhece bancos pelo nome e escolhe um símbolo relacionado à categoria.</p>
      <div className="grid max-h-48 grid-cols-4 gap-2 overflow-y-auto rounded-xl border border-[var(--border)] p-2 sm:grid-cols-5">
        <button
          type="button"
          aria-label={`${autoLabel} (recomendado)`}
          aria-pressed={!value}
          onClick={() => onChange("")}
          className={`flex min-h-[68px] flex-col items-center justify-center gap-1 rounded-lg border px-1 py-2 text-[10px] transition-colors ${!value ? "border-[var(--accent)] bg-[var(--accent)]/10" : "border-transparent hover:bg-[var(--panel2)]"}`}
        >
          <FinanceIconBadge iconId={autoIconId} size={34} />
          <span className="max-w-full truncate">{autoLabel}</span>
        </button>
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            aria-label={`Usar ícone ${option.label}`}
            aria-pressed={value === option.id}
            onClick={() => onChange(option.id)}
            className={`flex min-h-[68px] flex-col items-center justify-center gap-1 rounded-lg border px-1 py-2 text-[10px] transition-colors ${value === option.id ? "border-[var(--accent)] bg-[var(--accent)]/10" : "border-transparent hover:bg-[var(--panel2)]"}`}
          >
            <FinanceIconBadge iconId={option.id} size={34} />
            <span className="max-w-full truncate">{option.label}</span>
          </button>
        ))}
      </div>
    </fieldset>
  );
}
