import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { decryptPersonalAiKey } from "@/lib/personal-ai-crypto";
import { AIProviderError, classifyAIError, listProviderModels } from "@/lib/personal-ai/providers";
import { AI_PROVIDERS } from "@/lib/personal-ai/provider-config";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getVerifiedWorkspaceContext } from "@/lib/workspaces/server";

export const maxDuration = 15;

const schema = z.object({ provider: z.enum(AI_PROVIDERS), apiKey: z.string().trim().min(12).max(512).optional() }).strict();

export async function POST(request: NextRequest) {
  const active = await getVerifiedWorkspaceContext(request.headers.get("authorization"), request.headers.get("x-valurise-workspace-id"));
  if (!active.ok) return NextResponse.json({ error: active.error }, { status: active.status });
  const { user, workspace } = active;
  if (workspace.role !== "owner" && workspace.role !== "admin") return NextResponse.json({ error: "Somente quem administra este workspace pode configurar a IA." }, { status: 403 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Selecione um provedor e informe uma chave válida." }, { status: 400 });
  const { provider } = parsed.data;
  const admin = getSupabaseAdminClient();
  const rateKey = createHash("sha256").update(`personal-ai-models\0${user.id}`).digest("hex");
  const { data: allowed, error: rateError } = await admin.rpc("consume_public_rate_limit", { p_key: rateKey, p_max_attempts: 20, p_window_seconds: 3600 });
  if (rateError) {
    console.error("Val AI model-catalog rate-limit check failed", JSON.stringify({ code: rateError.code || "UNKNOWN" }));
    return NextResponse.json({ error: "Não foi possível consultar os modelos agora. A chave ainda não foi enviada ao provedor; tente novamente em instantes." }, { status: 503 });
  }
  if (allowed !== true) return NextResponse.json({ error: "Você atualizou o catálogo muitas vezes. Tente novamente mais tarde.", category: "APP_RATE_LIMITED", retryable: true }, { status: 429, headers: { "Retry-After": "3600" } });

  let apiKey = parsed.data.apiKey;
  if (!apiKey) {
    const { data: saved, error } = await admin.from("personal_ai_connections").select("provider, encrypted_api_key").eq("workspace_id", workspace.id).maybeSingle();
    if (error) return NextResponse.json({ error: "Não foi possível consultar a conexão salva." }, { status: 500 });
    if (saved?.provider === provider) {
      try { apiKey = decryptPersonalAiKey(saved.encrypted_api_key); }
      catch { return NextResponse.json({ error: "Não foi possível abrir a chave salva. Atualize a conexão nas Configurações." }, { status: 503 }); }
    }
  }
  if (!apiKey) return NextResponse.json({ error: "Cole a API key para carregar os modelos disponíveis. A chave será usada somente nesta consulta." }, { status: 400 });

  try {
    const models = await listProviderModels(provider, apiKey, AbortSignal.timeout(12_000));
    return NextResponse.json({ provider, models, fetchedAt: new Date().toISOString() });
  } catch (error) {
    const failure = classifyAIError(error, provider, "catalog");
    if (!(error instanceof AIProviderError)) console.error("Val AI catalog failure", JSON.stringify({ provider, category: failure.category, status: failure.httpStatus, requestId: failure.requestId }));
    return NextResponse.json({ error: failure.message, category: failure.category, providerMessage: failure.providerMessage, providerCode: failure.providerCode, providerHttpStatus: failure.httpStatus, requestId: failure.requestId, retryable: failure.retryable }, { status: failure.httpStatus === 429 ? 429 : 502 });
  }
}
