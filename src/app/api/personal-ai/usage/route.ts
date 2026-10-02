import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getVerifiedWorkspaceContext } from "@/lib/workspaces/server";
import { getValUsagePeriodStarts } from "@/lib/val-ai/periods";

export async function GET(request: NextRequest) {
  const active = await getVerifiedWorkspaceContext(request.headers.get("authorization"), request.headers.get("x-valurise-workspace-id"));
  if (!active.ok) return NextResponse.json({ error: active.error }, { status: active.status });
  const { user } = active;
  const admin = getSupabaseAdminClient();
  const { day, month } = getValUsagePeriodStarts();
  const [settingsResult, overrideResult, usageResult] = await Promise.all([
    admin.from("val_ai_runtime_settings").select("daily_requests, monthly_requests, daily_tokens, monthly_tokens").eq("id", 1).maybeSingle(),
    admin.from("val_ai_user_quota_overrides").select("daily_requests, monthly_requests, daily_tokens, monthly_tokens, is_blocked").eq("user_id", user.id).maybeSingle(),
    admin.from("val_ai_user_quota_usage").select("period_kind, period_start, requests").eq("user_id", user.id).in("period_kind", ["day", "month"]).in("period_start", [day, month]),
  ]);
  if (settingsResult.error || usageResult.error) return NextResponse.json({ error: "Não foi possível consultar o uso da Val." }, { status: 503 });
  const settings = settingsResult.data || { daily_requests: 0, monthly_requests: 0, daily_tokens: 0, monthly_tokens: 0 };
  const override = overrideResult.data;
  const dayUse = (usageResult.data || []).find((row) => row.period_kind === "day" && row.period_start === day);
  const monthUse = (usageResult.data || []).find((row) => row.period_kind === "month" && row.period_start === month);
  const dailyLimit = Number(override?.daily_requests ?? settings.daily_requests);
  const monthlyLimit = Number(override?.monthly_requests ?? settings.monthly_requests);
  return NextResponse.json({ available: true, blocked: override?.is_blocked === true, usage: {
    today: { requests: Number(dayUse?.requests || 0), limit: dailyLimit, remaining: Math.max(0, dailyLimit - Number(dayUse?.requests || 0)) },
    month: { requests: Number(monthUse?.requests || 0), limit: monthlyLimit, remaining: Math.max(0, monthlyLimit - Number(monthUse?.requests || 0)) },
  } }, { headers: { "Cache-Control": "no-store" } });
}
