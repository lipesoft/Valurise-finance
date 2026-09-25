export function normalizeCnpj(value: string) {
  return value.replace(/\D/g, "");
}

export function isValidCnpj(value: string) {
  const digits = normalizeCnpj(value);
  if (!/^\d{14}$/.test(digits) || /^([0-9])\1{13}$/.test(digits)) return false;

  const digitFor = (length: 12 | 13) => {
    const weights = length === 12
      ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
      : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const total = weights.reduce((sum, weight, index) => sum + Number(digits[index]) * weight, 0);
    const remainder = total % 11;
    return remainder < 2 ? 0 : 11 - remainder;
  };

  return digitFor(12) === Number(digits[12]) && digitFor(13) === Number(digits[13]);
}
