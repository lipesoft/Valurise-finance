import { describe, expect, it } from "vitest";
import { normalizeUsername } from "./username";

describe("normalizeUsername", () => {
  it("accepts names with spaces and accents as a valid account identifier", () => {
    expect(normalizeUsername("Grazi Borges")).toBe("grazi.borges");
    expect(normalizeUsername("  João  da Silva ")).toBe("joao.da.silva");
  });

  it("keeps supported separators and removes unsupported punctuation", () => {
    expect(normalizeUsername("ana_maria-01")).toBe("ana_maria-01");
    expect(normalizeUsername("  ! Ana /// Souza ! ")).toBe("ana.souza");
  });
});
