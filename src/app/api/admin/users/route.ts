import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSupabaseAdminClient, getVerifiedMaster } from "@/lib/supabase/admin";

// Master data is account-specific and must never be served from a cache.
export const dynamic = "force-dynamic";

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
    // Normally every Auth user has a profile created by the database trigger.
    // We deliberately start from Auth here as well, so a historical Auth-only
    // account cannot be left forever on the waiting screen without appearing
    // in the Master queue.
    users: (users.users ?? []).map((authUser) => {
      const profile = profileById.get(authUser.id);
      const metadata = (authUser.user_metadata ?? {}) as Record<string, unknown>;
      // A historical account may exist in Supabase Auth without a profile if
      // its creation trigger failed. It is still a real access request, so it
      // must be visible and approvable by the Master instead of disappearing.
      const fallbackProfile = profile ?? {
        id: authUser.id,
        full_name: typeof metadata.full_name === "string" ? metadata.full_name : null,
        username: typeof metadata.username === "string" ? metadata.username : null,
        public_id: null,
        account_status: "pending",
        account_role: "user",
        created_at: authUser.created_at,
        disabled_at: null,
        trashed_at: null,
      };
      return {
        id: fallbackProfile.id,
        email: authUser.email,
        lastSignInAt: authUser.last_sign_in_at,
        createdAt: fallbackProfile.created_at,
        profile: fallbackProfile,
      };
    }),
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
      if (removed.error) {
        if (removed.error.message.includes("workspace owner must transfer ownership before deletion")) {
          return NextResponse.json({ error: "Esta conta ainda administra uma empresa com outros integrantes. Transfira a titularidade antes de excluir definitivamente." }, { status: 409 });
        }
        error = removed.error;
      }
    }
  } else {
    const accountStatus = statusByAction[action];
    const { data: target, error: targetError } = await admin.auth.admin.getUserById(userId);
    if (targetError || !target.user) {
      return NextResponse.json({ error: "Conta não encontrada." }, { status: 404 });
    }
    const metadata = (target.user?.user_metadata ?? {}) as Record<string, unknown>;
    const profileUpdate = await admin
      .from("profiles")
      .upsert({
        id: userId,
        full_name: typeof metadata.full_name === "string" ? metadata.full_name : null,
        username: typeof metadata.username === "string" ? metadata.username : null,
        account_status: accountStatus,
        account_role: "user",
        disabled_at: action === "disable" ? new Date().toISOString() : null,
        trashed_at: action === "trash" ? new Date().toISOString() : null,
      }, { onConflict: "id" });
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
