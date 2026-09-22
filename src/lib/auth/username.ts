/**
 * Produces the identifier used for sign-in. Display names may contain spaces
 * and accents; the account identifier stays predictable and URL-safe.
 */
export function normalizeUsername(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9._-]+/g, ".")
    .replace(/[._-]{2,}/g, ".")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 32);
}
