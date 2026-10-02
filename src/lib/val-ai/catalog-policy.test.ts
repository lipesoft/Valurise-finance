import { describe, expect, it } from "vitest";
import { parseDeepseekModelCatalog, readSafeQuotaHeaders } from "./catalog-policy";

describe("DeepSeek catalog policy", () => {
  it("never classifies DeepSeek as free from its id or reported zero pricing", () => {
    const models = parseDeepseekModelCatalog({ data: [
      { id: "deepseek-chat:free", name: "Name says free", pricing: { prompt: "0", completion: "0" } },
      { id: "deepseek-reasoner", pricing: { prompt: "0.000001", completion: "0.000002" } },
    ] });

    expect(models.map((model) => model.model_id)).toEqual(["deepseek-chat:free", "deepseek-reasoner"]);
    expect(models.every((model) => model.provider_id === "deepseek" && model.is_free === false)).toBe(true);
  });

  it("accepts safe model ids and excludes hostile or non-chat ids", () => {
    const models = parseDeepseekModelCatalog({ data: [
      { id: "deepseek-chat" },
      { id: "vendor/../paid" },
      { id: "model?url=https" },
      { id: "deepseek-whisper-large" },
      { id: "deepseek-embedding-v3" },
      { id: "deepseek-text-chat", architecture: { output_modalities: ["text"] } },
    ] });

    expect(models.map((model) => model.model_id)).toEqual(["deepseek-chat", "deepseek-text-chat"]);
  });

  it("ignores provider-controlled header text that is not safe quota metadata", () => {
    const headers = new Headers({
      "x-ratelimit-remaining-tokens": "1200",
      "retry-after": "9.5",
      "x-ratelimit-reset": "in 10 seconds; api-key=secret",
      authorization: "Bearer never-store-this",
    });
    expect(readSafeQuotaHeaders(headers)).toEqual({
      "x-ratelimit-remaining-tokens": "1200",
      "retry-after": "9.5",
    });
  });
});
