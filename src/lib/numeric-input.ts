export type MoneyInputEdit = {
  inputType: string;
  data: string | null;
  selectionStart: number;
  selectionEnd: number;
};

export function inferMoneyInputEdit(previousValue: string, nextValue: string): MoneyInputEdit {
  let prefix = 0;
  while (prefix < previousValue.length && prefix < nextValue.length && previousValue[prefix] === nextValue[prefix]) prefix += 1;

  let previousEnd = previousValue.length;
  let nextEnd = nextValue.length;
  while (previousEnd > prefix && nextEnd > prefix && previousValue[previousEnd - 1] === nextValue[nextEnd - 1]) {
    previousEnd -= 1;
    nextEnd -= 1;
  }

  const removed = previousEnd > prefix;
  const inserted = nextValue.slice(prefix, nextEnd);
  const inputType = inserted
    ? removed ? "insertReplacementText" : inserted.length > 1 ? "insertFromPaste" : "insertText"
    : removed ? "deleteContentBackward" : "insertText";

  return {
    inputType,
    data: inserted || null,
    selectionStart: prefix,
    selectionEnd: previousEnd,
  };
}

function isGroupedInteger(value: string, separator: string) {
  const escaped = separator === "." ? "\\." : ",";
  return new RegExp(`^\\d{1,3}(?:${escaped}\\d{3})+$`).test(value);
}

function normalizeMoneyText(value: string, allowNegative = false): string | null {
  const cleaned = value
    .trim()
    .replace(/R\$/gi, "")
    .replace(/[\s\u00a0]/g, "")
    .replace(/[^\d.,-]/g, "");
  if (!cleaned) return "";

  const minusCount = (cleaned.match(/-/g) || []).length;
  if (minusCount > 1 || (minusCount === 1 && cleaned[0] !== "-")) return null;
  if (minusCount === 1 && !allowNegative) return null;

  const sign = minusCount === 1 ? "-" : "";
  const unsigned = minusCount === 1 ? cleaned.slice(1) : cleaned;
  if (!unsigned) return null;

  const lastComma = unsigned.lastIndexOf(",");
  const lastDot = unsigned.lastIndexOf(".");
  let decimalSeparator: "." | "," | null = null;
  let integerPart = unsigned;
  let fractionPart = "";

  if (lastComma >= 0 && lastDot >= 0) {
    decimalSeparator = lastComma > lastDot ? "," : ".";
  } else {
    const separator = lastComma >= 0 ? "," : lastDot >= 0 ? "." : null;
    if (separator) {
      const chunks = unsigned.split(separator);
      const allGroups = chunks.length > 1 && chunks.every((chunk) => chunk.length > 0) && isGroupedInteger(unsigned, separator);
      const trailingDecimal = chunks.at(-1) === "" && chunks.length === 2;
      const groupedPaste = separator === "," && allGroups;
      const groupedBrazilian = separator === "." && allGroups;
      if (!trailingDecimal && (groupedPaste || groupedBrazilian)) {
        integerPart = unsigned;
      } else {
        decimalSeparator = separator;
      }
    }
  }

  if (decimalSeparator) {
    const decimalIndex = unsigned.lastIndexOf(decimalSeparator);
    integerPart = unsigned.slice(0, decimalIndex);
    fractionPart = unsigned.slice(decimalIndex + 1);
    if (fractionPart.length > 2 || !/^\d*$/.test(fractionPart)) return null;
    const otherSeparator = decimalSeparator === "," ? "." : ",";
    if (integerPart.includes(otherSeparator) && !isGroupedInteger(integerPart, otherSeparator)) return null;
    if (integerPart.includes(decimalSeparator)) {
      if (!isGroupedInteger(integerPart, decimalSeparator)) return null;
    }
    integerPart = integerPart.replace(/[.,]/g, "");
  } else {
    if (!/^\d+(?:[.,]\d{3})*$/.test(integerPart)) return null;
    integerPart = integerPart.replace(/[.,]/g, "");
  }

  if (!/^\d*$/.test(integerPart)) return null;
  const whole = integerPart.replace(/^0+(?=\d)/, "") || "0";
  if (decimalSeparator) return `${sign}${whole}.${fractionPart}`;
  return `${sign}${whole}`;
}

function normalizeEditedCanonical(value: string, allowNegative = false): string | null {
  if (value === "") return "";
  const sign = value.startsWith("-") ? "-" : "";
  if (sign && !allowNegative) return null;
  const unsigned = sign ? value.slice(1) : value;
  if (!unsigned) return sign || null;
  if (!/^\d*(?:\.\d{0,2})?$/.test(unsigned)) return null;
  if (!/\d/.test(unsigned)) return null;

  const hasDecimal = unsigned.includes(".");
  const [integerPart, fractionPart = ""] = unsigned.split(".");
  const whole = integerPart.replace(/^0+(?=\d)/, "") || "0";
  return `${sign}${whole}${hasDecimal ? `.${fractionPart}` : ""}`;
}

function formatCanonicalMoney(value: string): string {
  if (!value) return "";
  const sign = value.startsWith("-") ? "-" : "";
  const unsigned = sign ? value.slice(1) : value;
  const hasDecimal = unsigned.includes(".");
  const [integerPart, fractionPart = ""] = unsigned.split(".");
  const grouped = (integerPart || "0").replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${sign}${grouped}${hasDecimal ? `,${fractionPart}` : ""}`;
}

export function formatMoneyInputValue(value: string, allowNegative = false): string | null {
  const canonical = normalizeMoneyText(value, allowNegative);
  if (canonical === null) return null;
  return formatCanonicalMoney(canonical);
}

export function parseMoneyInputToCents(value: string, allowNegative = false): number | null {
  const canonical = normalizeMoneyText(value, allowNegative);
  if (canonical === null || canonical === "") return null;
  const sign = canonical.startsWith("-") ? -1 : 1;
  const unsigned = canonical.startsWith("-") ? canonical.slice(1) : canonical;
  const [wholePart, fractionPart = ""] = unsigned.split(".");
  const whole = wholePart || "0";
  if (whole.length > 14) return null;
  const cents = sign * (Number(whole) * 100 + Number(fractionPart.padEnd(2, "0") || "0"));
  return Number.isSafeInteger(cents) ? cents : null;
}

function displayIndexToCanonicalIndex(display: string, index: number, canonical: string) {
  let canonicalIndex = 0;
  const limit = Math.max(0, Math.min(index, display.length));
  for (let position = 0; position < limit; position += 1) {
    const character = display[position];
    if (/\d/.test(character)) canonicalIndex += 1;
    else if (character === "," && canonical.includes(".")) canonicalIndex += 1;
    else if (character === "-" && canonical.startsWith("-")) canonicalIndex += 1;
  }
  return Math.min(canonicalIndex, canonical.length);
}

function normalizeInsertedText(value: string, inputType: string, allowNegative: boolean): string | null {
  if (inputType.toLowerCase().includes("paste") || value.length > 1) return normalizeMoneyText(value, allowNegative);
  let inserted = "";
  for (const character of value) {
    if (/\d/.test(character)) inserted += character;
    else if ((character === "," || character === ".") && !inserted.includes(".")) inserted += ".";
    else if (character === "-" && allowNegative && inserted.length === 0) inserted += "-";
  }
  return inserted;
}

export function applyMoneyInputEdit(
  currentDisplay: string,
  edit: MoneyInputEdit,
  allowNegative = false,
): string | null {
  const currentCanonical = normalizeMoneyText(currentDisplay, allowNegative);
  if (currentCanonical === null) return null;

  let start = displayIndexToCanonicalIndex(currentDisplay, edit.selectionStart, currentCanonical);
  let end = displayIndexToCanonicalIndex(currentDisplay, edit.selectionEnd, currentCanonical);
  if (end < start) [start, end] = [end, start];
  let nextCanonical = currentCanonical;

  if (edit.inputType.startsWith("delete")) {
    if (start === end) {
      if (edit.inputType.toLowerCase().includes("backward")) start = Math.max(0, start - 1);
      else end = Math.min(currentCanonical.length, end + 1);
    }
    nextCanonical = `${currentCanonical.slice(0, start)}${currentCanonical.slice(end)}`;
  } else if (edit.inputType.startsWith("insert")) {
    const inserted = normalizeInsertedText(edit.data || "", edit.inputType, allowNegative);
    if (inserted === null) return null;
    nextCanonical = `${currentCanonical.slice(0, start)}${inserted}${currentCanonical.slice(end)}`;
  } else {
    return formatMoneyInputValue(edit.data || "", allowNegative);
  }

  const normalized = normalizeEditedCanonical(nextCanonical, allowNegative);
  return normalized === null ? null : formatCanonicalMoney(normalized);
}

export function formatLocalizedDecimalInput(value: string): string {
  const cleaned = value.replace(/[^\d,.-]/g, "");
  const sign = cleaned.startsWith("-") ? "-" : "";
  const unsigned = cleaned.replace(/-/g, "");
  const separatorIndex = Math.max(unsigned.lastIndexOf(","), unsigned.lastIndexOf("."));
  if (separatorIndex < 0) return `${sign}${unsigned}`;
  const integerPart = unsigned.slice(0, separatorIndex).replace(/[.,]/g, "");
  const fractionPart = unsigned.slice(separatorIndex + 1).replace(/[.,]/g, "");
  return `${sign}${integerPart},${fractionPart}`;
}

export function formatGroupedInteger(value: string | number): string {
  const digits = String(value).replace(/\D/g, "");
  if (!digits) return "";
  const normalized = digits.replace(/^0+(?=\d)/, "") || "0";
  return normalized.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

export function parseGroupedInteger(value: string): number | null {
  const digits = value.replace(/[.\s\u00a0]/g, "");
  if (!/^\d+$/.test(digits)) return null;
  const parsed = Number(digits);
  return Number.isSafeInteger(parsed) ? parsed : null;
}
