import { describe, expect, it } from "vitest";
import { getValUsagePeriodStarts } from "./periods";

describe("Val usage periods", () => {
  it("uses the São Paulo local day and month near UTC midnight", () => {
    expect(getValUsagePeriodStarts(new Date("2026-10-02T02:30:00.000Z"))).toEqual({
      day: "2026-10-01",
      month: "2026-10-01",
    });
  });

  it("moves to the next local month only after midnight in Brazil", () => {
    expect(getValUsagePeriodStarts(new Date("2026-11-01T02:30:00.000Z"))).toEqual({
      day: "2026-10-31",
      month: "2026-10-01",
    });
    expect(getValUsagePeriodStarts(new Date("2026-11-01T03:30:00.000Z"))).toEqual({
      day: "2026-11-01",
      month: "2026-11-01",
    });
  });
});
