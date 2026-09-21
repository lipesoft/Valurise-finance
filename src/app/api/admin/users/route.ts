import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSupabaseAdminClient, getVerifiedMaster } from "@/lib/supabase/admin";

const actionSchema = z.object({
  userId: z.string().uuid(),
  action: z.enum(["approve", "disable", "restore", "trash", "delete_permanently"]),
});

async function authorize(request: NextRequest) {
  const master = await getVerifiedMaster(request.headers.get("authorization"));
  return master ? { master } : { response: NextResponse.json({ error: "Não autorizado." }, { status: 403 }) };
}

export async function GET(request: NextRequest) {
  const result = await authorize(request);
  if ("response" in result) return result.response;
  const admin = getSupabaseAdminClient();
  const [{ data: users, error: usersError }, { data: profiles, error: profilesError }] = await Promise.all([
    admin.auth.admin.listUsers({ page: 1, perPage: 200 }),
    admin.from("profiles").select("id, full_name, username, public_id, account_status, account_role, created_at, disabled_at, trashed_at"),
  ]);
  if (usersError || profilesError) return NextResponse.json({ error: "Não foi possível carregar usuários." }, { status: 500 });
  const profileById = new Map((profiles ?? []).map((profile) => [profile.id, profile]));
  return NextResponse.json({
    users: (users.users ?? []).map((user) => ({
      id: user.id,
      email: user.email,
      lastSignInAt: user.last_sign_in_at,
      createdAt: user.created_at,
      profile: profileById.get(user.id) ?? null,
    })),
  });
}

export async function POST(request: NextRequest) {
  const result = await authorize(request);
  if ("response" in result) return result.response;
  const payload = actionSchema.safeParse(await request.json());
  if (!payload.success) return NextResponse.json({ error: "Ação inválida." }, { status: 400 });
  if (payload.data.userId === result.master.id) return NextResponse.json({ error: "Você não pode alterar sua própria conta master por aqui." }, { status: 400 });

  const admin = getSupabaseAdminClient();
  const statusByAction = { approve: "active", disable: "disabled", restore: "active", trash: "trashed" } as const;
  const { userId, action } = payload.data;
  let error: { message: string } | null = null;

  if (action === "delete_permanently") {
    // Deleting Auth cascades financial data. Active RLS checks already deny the account while trashed.
    const ban = await admin.auth.admin.updateUserById(userId, { ban_duration: "876000h" });
    if (ban.error) error = ban.error;
    if (!error) {
      const removed = await admin.auth.admin.deleteUser(userId);
      if (removed.error) error = removed.error;
    }
  } else {
    const accountStatus = statusByAction[action];
    const profileUpdate = await admin
      .from("profiles")
      .update({
        account_status: accountStatus,
        disabled_at: action === "disable" ? new Date().toISOString() : null,
        trashed_at: action === "trash" ? new Date().toISOString() : null,
      })
      .eq("id", userId);
    error = profileUpdate.error;
    if (!error && (action === "disable" || action === "trash")) {
      const ban = await admin.auth.admin.updateUserById(userId, { ban_duration: "876000h" });
      error = ban.error;
    }
    if (!error && (action === "approve" || action === "restore")) {
      const unban = await admin.auth.admin.updateUserById(userId, { ban_duration: "none" });
      error = unban.error;
    }
  }
  if (error) return NextResponse.json({ error: "Não foi possível atualizar esta conta." }, { status: 500 });

  await admin.from("master_audit_log").insert({
    actor_id: result.master.id,
    target_user_id: action === "delete_permanently" ? null : userId,
    action: action === "delete_permanently" ? "permanently_deleted" : action === "approve" ? "approved" : action === "restore" ? "restored" : action === "trash" ? "trashed" : "disabled",
  });
  return NextResponse.json({ ok: true });
}
