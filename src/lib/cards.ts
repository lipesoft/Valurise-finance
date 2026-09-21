/** The billing cycle usually turns on the day after the invoice closes. */
export function bestPurchaseDay(closingDay?: string | number) {
  const day = Number(closingDay);
  if (!Number.isInteger(day) || day < 1 || day > 31) return undefined;
  return day === 31 ? 1 : day + 1;
}
