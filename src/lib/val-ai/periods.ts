export const VAL_USAGE_TIME_ZONE = "America/Sao_Paulo";

function localDateParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: VAL_USAGE_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  return Object.fromEntries(parts.map(({ type, value }) => [type, value]));
}

export function getValUsagePeriodStarts(now = new Date()) {
  const parts = localDateParts(now);
  const day = `${parts.year}-${parts.month}-${parts.day}`;
  const month = `${parts.year}-${parts.month}-01`;
  return { day, month };
}
