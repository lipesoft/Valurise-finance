/** The billing cycle usually turns on the day after the invoice closes. */
export function bestPurchaseDay(closingDay?: string | number) {
  const day = Number(closingDay);
  if (!Number.isInteger(day) || day < 1 || day > 31) return undefined;
  return day === 31 ? 1 : day + 1;
}

/** The old default "Crédito" is a type label, not a user-provided nickname. */
export function normalizeCardNickname(nickname?: string | null) {
  const trimmed = nickname?.trim();
  if (!trimmed || normalizeText(trimmed) === "credito") return undefined;
  return trimmed;
}

/** Show the optional nickname once, followed by the card type. */
export function cardDisplayLabel(nickname?: string | null) {
  const normalizedNickname = normalizeCardNickname(nickname);
  return normalizedNickname ? `${normalizedNickname} · crédito` : "Crédito";
}

/** Keep the stable identifier used by existing transactions. */
export function cardAccountLabel(nickname?: string | null) {
  return normalizeCardNickname(nickname) ?? "Crédito";
}

function normalizeText(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR");
}
