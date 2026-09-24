import { NextRequest, NextResponse } from "next/server";
import { getVerifiedActiveUser } from "@/lib/supabase/admin";
import { createUserScopedSupabaseClient } from "@/lib/supabase/user-scoped";

export async function GET(request: NextRequest) {
  const user = await getVerifiedActiveUser(request.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Não autorizado." }, { status: 401 });
  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim() || "";
  const { data, error } = await createUserScopedSupabaseClient(token).from("personal_ai_usage_monthly")
    .select("month_start, request_count, chat_count, input_tokens, output_tokens")
    .eq("user_id", user.id).eq("month_start", month).maybeSingle();
  if (error) {
    // The UI can still operate while an additive usage migration is being deployed.
    if (error.code === "42P01" || error.code === "PGRST205") return NextResponse.json({ available: false, usage: null });
    return NextResponse.json({ error: "Não foi possível consultar o uso da IA." }, { status: 500 });
  }
  const usage = data ? {
    month: data.month_start,
    requests: data.request_count,
    chatRequests: data.chat_count,
    inputTokens: data.input_tokens,
    outputTokens: data.output_tokens,
    totalTokens: Number(data.input_tokens) + Number(data.output_tokens),
    quotaTokens: null,
  } : { month, requests: 0, chatRequests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, quotaTokens: null };
  return NextResponse.json({ available: true, usage });
}
