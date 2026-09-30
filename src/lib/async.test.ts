import { afterEach, describe, expect, it, vi } from "vitest";
import { withTimeout } from "./async";

describe("withTimeout", () => {
  afterEach(() => vi.useRealTimers());

  it("rejects with a recognizable timeout when an operation never settles", async () => {
    vi.useFakeTimers();
    const pending = withTimeout(new Promise<never>(() => {}), 100, "Operação demorou.");
    const assertion = expect(pending).rejects.toMatchObject({ name: "TimeoutError", message: "Operação demorou." });

    await vi.advanceTimersByTimeAsync(100);
    await assertion;
  });

  it("returns successful results and clears the fallback timer", async () => {
    vi.useFakeTimers();

    await expect(withTimeout(Promise.resolve("ok"), 100, "Operação demorou.")).resolves.toBe("ok");
    expect(vi.getTimerCount()).toBe(0);
  });
});
