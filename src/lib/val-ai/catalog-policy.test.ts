import { describe, expect, it } from "vitest";
import { parseProviderModelCatalog, readSafeQuotaHeaders, verifyCurrentFreeCatalogEntry } from "./catalog-policy";

describe("Val AI provider catalog policy", () => {
  it("only recognizes OpenRouter as free when both official prices are exactly zero", () => {
    const models = parseProviderModelCatalog("openrouter", { data: [
      { id: "vendor/zero", pricing: { prompt: "0", completion: "0" } },
      { id: "vendor/paid", pricing: { prompt: "0", completion: "0.000001" } },
      { id: "vendor/missing", pricing: { prompt: "0" } },
      { id: "vendor/name:free", name: "Free model", pricing: { prompt: "0.2", completion: "0.2" } },
    ] });
    expect(models.map((model) => [model.model_id, model.is_free])).toEqual([
      ["vendor/zero", true], ["vendor/missing", false], ["vendor/name:free", false], ["vendor/paid", false],
    ]);
  });

  it("does not infer Groq price from model ids or its OpenAI-compatible naming", () => {
    const models = parseProviderModelCatalog("groq", { data: [
      { id: "openai/gpt-oss-20b:free" },
      { id: "qwen/qwen3-32b" },
    ] });
    expect(models).toHaveLength(2);
    expect(models.every((model) => model.is_free === false)).toBe(true);
    expect(models.every((model) => model.official_prompt_price === null)).toBe(true);
  });

  it("accepts safe slash-separated model ids and excludes hostile or non-chat ids", () => {
    const models = parseProviderModelCatalog("openrouter", { data: [
      { id: "qwen/model-v2:free", pricing: { prompt: 0, completion: 0 } },
      { id: "vendor/../paid", pricing: { prompt: 0, completion: 0 } },
      { id: "vendor/model?url=https", pricing: { prompt: 0, completion: 0 } },
      { id: "vendor/whisper-large", pricing: { prompt: 0, completion: 0 } },
      { id: "vendor/tts-model", pricing: { prompt: 0, completion: 0 } },
      { id: "vendor/embedding-v3", pricing: { prompt: 0, completion: 0 } },
      { id: "vendor/image-only", architecture: { output_modalities: ["image"] }, pricing: { prompt: 0, completion: 0 } },
      { id: "vendor/text-chat", architecture: { output_modalities: ["text"] }, pricing: { prompt: 0, completion: 0 } },
    ] });
    expect(models.map((model) => model.model_id)).toEqual(["qwen/model-v2:free", "vendor/text-chat"]);
  });

  it("puts confirmed free entries before paid and unknown-price entries", () => {
    const models = parseProviderModelCatalog("openrouter", { data: [
      { id: "z/paid", pricing: { prompt: 1, completion: 1 } },
      { id: "a/free", pricing: { prompt: 0, completion: 0 } },
      { id: "b/unknown", pricing: {} },
      { id: "c/free", pricing: { prompt: 0, completion: 0 } },
    ] });
    expect(models.map((model) => model.model_id)).toEqual(["a/free", "c/free", "b/unknown", "z/paid"]);
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

  it("blocks an OpenRouter price change immediately before a model call", () => {
    const paid = parseProviderModelCatalog("openrouter", { data: [
      { id: "vendor/model:free", pricing: { prompt: "0.000001", completion: "0" } },
    ] });
    expect(verifyCurrentFreeCatalogEntry("openrouter", "vendor/model:free", paid, true)).toBe("MODEL_NOT_ZERO_PRICED");
    expect(verifyCurrentFreeCatalogEntry("openrouter", "removed/model", paid, true)).toBe("MODEL_NOT_IN_CATALOG");
  });

  it("requires fresh model presence and an active free-tier attestation for Groq", () => {
    const groq = parseProviderModelCatalog("groq", { data: [{ id: "qwen/model" }] });
    expect(verifyCurrentFreeCatalogEntry("groq", "qwen/model", groq, false)).toBe("GROQ_FREE_TIER_NOT_CONFIRMED");
    expect(verifyCurrentFreeCatalogEntry("groq", "qwen/model", groq, true)).toBe("VERIFIED_FREE");
    expect(verifyCurrentFreeCatalogEntry("groq", "removed/model", groq, true)).toBe("MODEL_NOT_IN_CATALOG");
  });
});
