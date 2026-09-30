import { describe, expect, it } from "vitest";
import { applyMoneyInputEdit, formatGroupedInteger, formatLocalizedDecimalInput, formatMoneyInputValue, inferMoneyInputEdit, parseGroupedInteger, parseMoneyInputToCents } from "./numeric-input";

describe("localized financial inputs", () => {
  it("groups thousands as the user types without forcing cents", () => {
    expect(formatMoneyInputValue("1500000")).toBe("1.500.000");
    expect(formatMoneyInputValue("1500000,25")).toBe("1.500.000,25");
  });

  it("formats Brazilian and pasted international currency values", () => {
    expect(formatMoneyInputValue("R$ 1.500.000,25")).toBe("1.500.000,25");
    expect(formatMoneyInputValue("1,500,000.25")).toBe("1.500.000,25");
    expect(formatMoneyInputValue("1500000.25")).toBe("1.500.000,25");
  });

  it("keeps an unfinished decimal separator available while typing", () => {
    expect(formatMoneyInputValue("1500000,")).toBe("1.500.000,");
  });

  it("converts grouped values to cents and rejects invalid precision", () => {
    expect(parseMoneyInputToCents("1.500.000,25")).toBe(150_000_025);
    expect(parseMoneyInputToCents("1.234.567")).toBe(123_456_700);
    expect(parseMoneyInputToCents("")).toBeNull();
    expect(parseMoneyInputToCents("1.234,567")).toBeNull();
    expect(parseMoneyInputToCents("-20,00")).toBeNull();
    expect(parseMoneyInputToCents("-20,00", true)).toBe(-2_000);
  });

  it("handles digit insertion and deletion across a generated group separator", () => {
    expect(applyMoneyInputEdit("123", { inputType: "insertText", data: "4", selectionStart: 3, selectionEnd: 3 })).toBe("1.234");
    expect(applyMoneyInputEdit("1.234", { inputType: "deleteContentBackward", data: null, selectionStart: 5, selectionEnd: 5 })).toBe("123");
    expect(applyMoneyInputEdit("", { inputType: "insertText", data: "1.200,00", selectionStart: 0, selectionEnd: 0 })).toBe("1.200,00");
  });

  it("infers keyboard edits and pasted values when beforeinput is unavailable", () => {
    expect(inferMoneyInputEdit("1", "15")).toEqual({ inputType: "insertText", data: "5", selectionStart: 1, selectionEnd: 1 });
    expect(inferMoneyInputEdit("1.234", "1.2345")).toEqual({ inputType: "insertText", data: "5", selectionStart: 5, selectionEnd: 5 });
    expect(inferMoneyInputEdit("", "1500000,25")).toEqual({ inputType: "insertFromPaste", data: "1500000,25", selectionStart: 0, selectionEnd: 0 });
  });

  it("formats decimal percentages and large whole-number quotas for display", () => {
    expect(formatLocalizedDecimalInput("12.5")).toBe("12,5");
    expect(formatGroupedInteger("1500000")).toBe("1.500.000");
    expect(parseGroupedInteger("1.500.000")).toBe(1_500_000);
    expect(parseGroupedInteger("1.500.000,5")).toBeNull();
  });
});
