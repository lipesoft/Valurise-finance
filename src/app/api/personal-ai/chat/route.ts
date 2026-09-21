import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { decryptPersonalAiKey } from "@/lib/personal-ai-crypto";
import { financialSnapshot, personalAiInstruction } from "@/lib/personal-ai";
import { getSupabaseAdminClient, getVerifiedActiveUser } from "@/lib/supabase/admin";

const schema = z.object({
  messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().trim().min(1).max(2000) })).min(1).max(12),
});

function openAiText(payload: unknown) {
  const value = payload as { output_text?: string; output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }> };
  if (value.output_text) return value.output_text.trim();
  return value.output?.flatMap((item) => item.content || []).filter((item) => item.type === "output_text").map((item) => item.text || "").join("\n").trim();
}

function geminiText(payload: unknown) {
  const value = payload as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  return value.candidates?.[0]?.content?.parts?.map((item) => item.text || "").join("\n").trim();
}

export async function POST(request: NextRequest) {
  const user = await getVerifiedActiveUser(request.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Não autorizado." }, { status: 401 });
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: "Mensagem inválida." }, { status: 400 });

  const admin = getSupabaseAdminClient();
  const [{ data: connection, error: connectionError }, { data: state }] = await Promise.all([
    admin.from("personal_ai_connections").select("provider, encrypted_api_key, model, insights_enabled").eq("user_id", user.id).maybeSingle(),
    admin.from("user_financial_state").select("state").eq("user_id", user.id).maybeSingle(),
  ]);
  if (connectionError || !connection) return NextResponse.json({ error: "Conecte sua IA pessoal nas Configurações antes de conversar." }, { status: 409 });

  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 30_000);
  try {
    const apiKey = decryptPersonalAiKey(connection.encrypted_api_key);
    const snapshot = JSON.stringify(financialSnapshot(state?.state));
    const messages = parsed.data.messages;
    let reply = "";
    if (connection.provider === "openai") {
      const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        signal: abort.signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: connection.model,
          store: false,
          instructions: `${personalAiInstruction}\n\nRETRATO FINANCEIRO LIMITADO E ATUAL:\n${snapshot}`,
          input: messages.map((item) => ({ role: item.role, content: item.content })),
          text: { verbosity: "low" },
        }),
      });
      if (!response.ok) return NextResponse.json({ error: "A OpenAI recusou a solicitação. Revise a chave, o modelo e os créditos da sua conta." }, { status: 422 });
      reply = openAiText(await response.json()) || "";
    } else {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(connection.model)}:generateContent`, {
        method: "POST",
        signal: abort.signal,
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: `${personalAiInstruction}\n\nRETRATO FINANCEIRO LIMITADO E ATUAL:\n${snapshot}` }] },
          contents: messages.map((item) => ({ role: item.role === "assistant" ? "model" : "user", parts: [{ text: item.content }] })),
          generationConfig: { temperature: 0.25, maxOutputTokens: 700 },
        }),
      });
      if (!response.ok) return NextResponse.json({ error: "O Gemini recusou a solicitação. Revise a chave, o modelo e os créditos da sua conta." }, { status: 422 });
      reply = geminiText(await response.json()) || "";
    }
    if (!reply) return NextResponse.json({ error: "A IA não retornou uma resposta utilizável." }, { status: 502 });
    const current = messages.at(-1)!;
    await admin.from("personal_ai_messages").insert([
      { user_id: user.id, role: "user", content: current.content },
      { user_id: user.id, role: "assistant", content: reply },
    ]);
    return NextResponse.json({ reply });
  } catch {
    return NextResponse.json({ error: "Não foi possível conversar com sua IA agora. Tente novamente." }, { status: 503 });
  } finally {
    clearTimeout(timeout);
  }
}
