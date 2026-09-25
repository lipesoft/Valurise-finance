import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { generateText } from "ai";
import { z } from "zod";
import { decryptPersonalAiKey } from "@/lib/personal-ai-crypto";
import { AIProviderError, classifyAIError, createProviderModel, logAIError, type AIProvider } from "@/lib/personal-ai/providers";
import { isGemini25FlashModel, isSupportedGeminiModel } from "@/lib/personal-ai/model-options";
import { getSupabaseAdminClient, getVerifiedActiveUser } from "@/lib/supabase/admin";
import { recordPersonalAIUsage } from "@/lib/personal-ai/usage";

export const maxDuration = 15;

const schema = z.object({
  provider: z.enum(["openai", "gemini", "deepseek"]),
  model: z.string().trim().min(2).max(100).regex(/^[A-Za-z0-9._:-]+$/),
  apiKey: z.string().trim().min(12).max(512).optional(),
}).strict();

export async function POST(request: NextRequest) {
  const user = await getVerifiedActiveUser(request.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Não autorizado." }, { status: 401 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Provedor, modelo ou chave inválidos." }, { status: 400 });
  const { provider, model } = parsed.data;
  if (provider === "gemini" && !isSupportedGeminiModel(model)) {
    return NextResponse.json({ error: "Modelo Gemini não habilitado no Valurise. Escolha gemini-2.5-flash-lite ou gemini-2.5-flash.", category: "INVALID_MODEL", providerCode: "MODEL_NOT_ALLOWED", model }, { status: 400 });
  }
  const admin = getSupabaseAdminClient();
  const rateKey = createHash("sha256").update(`personal-ai-test\0${user.id}`).digest("hex");
  const { data: allowed, error: rateError } = await admin.rpc("consume_public_rate_limit", { p_key: rateKey, p_max_attempts: 10, p_window_seconds: 3600 });
  if (rateError) {
    console.error("Val AI connection-test rate-limit check failed", JSON.stringify({ code: rateError.code || "UNKNOWN" }));
    return NextResponse.json({ error: "Não foi possível validar o limite seguro do teste. A chave e o modelo não chegaram a ser testados; tente novamente em instantes." }, { status: 503 });
  }
  if (allowed !== true) return NextResponse.json({ error: "Limite de testes desta hora atingido no Valurise. Tente novamente mais tarde.", category: "APP_RATE_LIMITED", retryable: true, model }, { status: 429, headers: { "Retry-After": "3600" } });

  const { data: saved, error: savedError } = await admin.from("personal_ai_connections")
    .select("provider, model, encrypted_api_key, updated_at").eq("user_id", user.id).maybeSingle();
  if (savedError) return NextResponse.json({ error: "Não foi possível consultar a conexão salva." }, { status: 500 });
  let apiKey = parsed.data.apiKey;
  if (!apiKey && saved?.provider === provider) {
    try { apiKey = decryptPersonalAiKey(saved.encrypted_api_key); }
    catch { return NextResponse.json({ error: "Não foi possível abrir a chave salva. Atualize a conexão nas Configurações." }, { status: 503 }); }
  }
  if (!apiKey) return NextResponse.json({ error: "Informe a API key antes de testar esta conexão." }, { status: 400 });

  let matchesSavedConnection = Boolean(saved && saved.provider === provider && saved.model === model && !parsed.data.apiKey);
  if (saved && saved.provider === provider && saved.model === model && parsed.data.apiKey) {
    try { matchesSavedConnection = decryptPersonalAiKey(saved.encrypted_api_key) === apiKey; }
    catch { matchesSavedConnection = false; }
  }

  const startedAt = Date.now();
  try {
    // This explicit user action sends only a tiny health-check prompt, never financial data.
    const gemini25Flash = provider === "gemini" && isGemini25FlashModel(model);
    const result = await generateText({
      model: createProviderModel(provider as AIProvider, apiKey, model),
      prompt: "Responda somente: OK",
      maxOutputTokens: gemini25Flash ? 32 : provider === "gemini" ? 128 : 6,
      ...(provider !== "gemini" ? { temperature: 0 } : {}),
      ...(gemini25Flash ? { providerOptions: { google: { thinkingConfig: { thinkingBudget: 0 } } } } : {}),
      maxRetries: 0,
      timeout: 12_000,
      abortSignal: AbortSignal.timeout(12_000),
    });
    if (!result.text.trim()) throw new AIProviderError({ provider: provider as AIProvider, model, category: result.finishReason === "content-filter" ? "CONTENT_BLOCKED" : "MALFORMED_RESPONSE", providerCode: result.finishReason });
    const latencyMs = Date.now() - startedAt;
    await recordPersonalAIUsage({ userId: user.id, provider: provider as AIProvider, model, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, latencyMs, kind: "connection_test" });
    let validatedAt: string | null = null;
    if (matchesSavedConnection && saved) {
      const testedAt = new Date().toISOString();
      const { data: updated, error: validationError } = await admin.from("personal_ai_connections")
        .update({ validated_at: testedAt, validated_model: model })
        .eq("user_id", user.id).eq("provider", provider).eq("model", model).eq("updated_at", saved.updated_at)
        .select("user_id").maybeSingle();
      if (validationError) {
        console.error("Val AI connection validation persistence failed", JSON.stringify({ provider, code: validationError.code || "UNKNOWN" }));
        return NextResponse.json({ error: "O provedor respondeu, mas não foi possível registrar a validação. Tente o teste novamente." }, { status: 503 });
      }
      if (updated) validatedAt = testedAt;
    }
    return NextResponse.json({ ok: true, provider, model, latencyMs, validated: Boolean(validatedAt), validatedAt, usage: { inputTokens: result.usage.inputTokens ?? null, outputTokens: result.usage.outputTokens ?? null } });
  } catch (error) {
    const failure = classifyAIError(error, provider as AIProvider, model);
    const latencyMs = Date.now() - startedAt;
    logAIError(failure, latencyMs);
    await recordPersonalAIUsage({ userId: user.id, provider: provider as AIProvider, model, latencyMs, kind: "connection_test", error: failure });
    return NextResponse.json({ error: failure.message, category: failure.category, providerMessage: failure.providerMessage, providerCode: failure.providerCode, providerHttpStatus: failure.httpStatus, requestId: failure.requestId, retryable: failure.retryable, model }, { status: failure.httpStatus === 429 ? 429 : 502 });
  }
}
