export function printFinancePdf(fileName: string) {
  if (typeof window === "undefined") return;
  const previousTitle = document.title;
  const safeName = fileName
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "relatorio-valurise";
  let restored = false;
  const restoreTitle = () => {
    if (restored) return;
    restored = true;
    document.title = previousTitle;
    window.removeEventListener("afterprint", restoreTitle);
    window.clearTimeout(fallbackTimer);
  };
  const fallbackTimer = window.setTimeout(restoreTitle, 30_000);

  document.title = `${safeName}.pdf`;
  window.addEventListener("afterprint", restoreTitle, { once: true });
  try {
    window.print();
  } catch {
    restoreTitle();
    throw new Error("Não foi possível abrir a exportação para PDF.");
  }
}
