import { describe, expect, it } from "vitest";
import { createBusinessFinanceTools } from "./tools";

function execute(tool: { execute?: (...args: never[]) => unknown }, input: unknown = {}) {
  if (!tool.execute) throw new Error("Tool without an executor");
  return tool.execute(input as never, { toolCallId: "business-tool-test", messages: [], abortSignal: new AbortController().signal } as never);
}

describe("contexto empresarial da Val", () => {
  it("preserva natureza e origem e não transforma estimativa em faturamento realizado", async () => {
    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const date = new Date(now.getFullYear(), now.getMonth(), 5, 12).toISOString();
    const tools = createBusinessFinanceTools({
      data: { institutions: [{ name: "Banco QA", accounts: [{ name: "Conta", balance: 150_000 }] }] },
      transactions: [{ id: "income", type: "income", amountCents: 80_000, category: "Vendas", account: "Banco QA • Conta", date, createdAt: date }],
    }, async (period) => [{ metricKey: "monthly_revenue", amountCents: 100_000, nature: "estimated", source: "manual", referenceMonth: `${period}-01` }]);
    const result = JSON.parse(String(await execute(tools.getBusinessFinanceOverview, { period: "current_month" })));
    expect(result.result.workspaceType).toBe("business");
    expect(result.result.period).toBe(currentMonth);
    expect(result.result.indicators.grossRevenue).toMatchObject({ amountCents: 80_000, nature: "actual", source: "transactions" });
    expect(result.result.indicators.monthlyReference).toMatchObject({ amountCents: 100_000, nature: "estimated", source: "manual" });
    expect(result.result.indicators.managerialResult.amountCents).toBeNull();
    expect(result.result.provenance).toContain("null, não zero");
  });
});
