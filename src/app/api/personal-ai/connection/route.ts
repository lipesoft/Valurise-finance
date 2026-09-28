import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { legalVersions } from "@/lib/legal-content";
import { loadValRouterRuntime, valFeatureIsEnabled } from "@/lib/val-ai/router";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getVerifiedWorkspaceContext } from "@/lib/workspaces/server";

const preferencesSchema = z.object({
  insightsEnabled: z.boolean(),
  actionsEnabled: z.boolean().default(false),
}).strict();

async function workspaceFrom(request: NextRequest) {
  return getVerifiedWorkspaceContext(request.headers.get("authorization"), request.headers.get("x-valurise-workspace-id"));
}

export async function GET(request: NextRequest) {
  const active = await workspaceFrom(request);
  if (!active.ok) return NextResponse.json({ error: active.error }, { status: active.status });
  const { user, workspace } = active;
  const admin = getSupabaseAdminClient();
  const [{ data: preference, error: preferenceError }, { data: consent, error: consentError }, runtime] = await Promise.all([
    admin.from("val_ai_user_preferences").select("actions_enabled, updated_at").eq("workspace_id", workspace.id).eq("user_id", user.id).maybeSingle(),
    admin.from("workspace_ai_consents").select("ai_data_sharing_version, accepted_at, revoked_at").eq("user_id", user.id).eq("workspace_id", workspace.id).maybeSingle(),
    loadValRouterRuntime({}),
  ]);
  if (preferenceError || consentError) return NextResponse.json({ error: "A Central da Val ainda está sendo preparada." }, { status: 503 });
  const insightsEnabled = consent?.ai_data_sharing_version === legalVersions.aiSharing && Boolean(consent.accepted_at);
  const renewalRequired = Boolean(consent?.accepted_at && consent.ai_data_sharing_version !== legalVersions.aiSharing);
  return NextResponse.json({ connection: {
    available: runtime.enabled && runtime.candidates.length > 0,
    insights_enabled: insightsEnabled,
    actions_enabled: Boolean(preference?.actions_enabled && insightsEnabled),
    actions_allowed: valFeatureIsEnabled(runtime.settings, "actions"),
    consentRenewalRequired: renewalRequired,
  } }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: NextRequest) {
  const active = await workspaceFrom(request);
  if (!active.ok) return NextResponse.json({ error: active.error }, { status: active.status });
  const { user, workspace } = active;
  const body = await request.json().catch(() => null);
  const parsed = preferencesSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Preferências da Val inválidas." }, { status: 400 });
  if (parsed.data.actionsEnabled && !parsed.data.insightsEnabled) return NextResponse.json({ error: "Para permitir propostas, autorize primeiro o contexto financeiro." }, { status: 400 });

  const admin = getSupabaseAdminClient();
  const now = new Date().toISOString();
  const [{ data: runtime }, { data: current }] = await Promise.all([
    admin.from("val_ai_runtime_settings").select("val_enabled, val_router_enabled, val_actions_enabled, val_insights_enabled").eq("id", 1).maybeSingle(),
    admin.from("val_ai_user_preferences").select("actions_enabled").eq("workspace_id", workspace.id).eq("user_id", user.id).maybeSingle(),
  ]);
  if (parsed.data.actionsEnabled && !runtime?.val_actions_enabled) return NextResponse.json({ error: "As propostas da Val estão temporariamente desativadas." }, { status: 409 });

  const consentAt = parsed.data.insightsEnabled ? now : null;
  const { error: consentError } = await admin.from("workspace_ai_consents").upsert({
    user_id: user.id, workspace_id: workspace.id,
    ai_data_sharing_version: parsed.data.insightsEnabled ? legalVersions.aiSharing : null,
    accepted_at: consentAt, revoked_at: parsed.data.insightsEnabled ? null : now, updated_at: now,
  }, { onConflict: "user_id,workspace_id" });
  if (consentError) return NextResponse.json({ error: "Não foi possível salvar a preferência de privacidade." }, { status: 503 });
  const actionsEnabled = parsed.data.insightsEnabled && parsed.data.actionsEnabled;
  const { error: preferenceError } = await admin.from("val_ai_user_preferences").upsert({
    user_id: user.id, workspace_id: workspace.id, actions_enabled: actionsEnabled, updated_at: now,
  }, { onConflict: "user_id,workspace_id" });
  if (preferenceError) return NextResponse.json({ error: "O consentimento foi atualizado, mas não foi possível salvar a permissão de ações." }, { status: 503 });

  const { data: cancelled, error: cancelError } = await admin.from("personal_ai_action_proposals")
    .update({ status: "cancelled", acted_at: now }).eq("user_id", user.id).eq("workspace_id", workspace.id).eq("status", "pending").select("id");
  if (cancelError) return NextResponse.json({ error: "Preferência salva, mas não foi possível encerrar propostas antigas. Não confirme propostas anteriores; tente novamente." }, { status: 503 });
  const runtimeNow = await loadValRouterRuntime({});
  return NextResponse.json({ ok: true, pendingProposalsCancelled: Boolean(cancelled?.length), connection: {
    available: runtimeNow.enabled && runtimeNow.candidates.length > 0,
    insights_enabled: parsed.data.insightsEnabled,
    actions_enabled: actionsEnabled,
    actions_allowed: runtime?.val_actions_enabled === true,
    consentRenewalRequired: false,
  } }, { headers: { "Cache-Control": "no-store" } });
}

export async function DELETE(request: NextRequest) {
  const active = await workspaceFrom(request);
  if (!active.ok) return NextResponse.json({ error: active.error }, { status: active.status });
  const { user, workspace } = active;
  const admin = getSupabaseAdminClient();
  const now = new Date().toISOString();
  const [{ error: preferenceError }, { error: consentError }, { error: proposalError }] = await Promise.all([
    admin.from("val_ai_user_preferences").upsert({ user_id: user.id, workspace_id: workspace.id, actions_enabled: false, updated_at: now }, { onConflict: "user_id,workspace_id" }),
    admin.from("workspace_ai_consents").upsert({ user_id: user.id, workspace_id: workspace.id, ai_data_sharing_version: null, accepted_at: null, revoked_at: now, updated_at: now }, { onConflict: "user_id,workspace_id" }),
    admin.from("personal_ai_action_proposals").update({ status: "cancelled", acted_at: now }).eq("user_id", user.id).eq("workspace_id", workspace.id).eq("status", "pending"),
  ]);
  if (preferenceError || consentError || proposalError) return NextResponse.json({ error: "Não foi possível revogar todas as permissões da Val. Tente novamente." }, { status: 503 });
  // Legacy encrypted per-user keys remain untouched for a non-destructive migration.
  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
