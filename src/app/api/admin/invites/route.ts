import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSupabaseAdminClient, getVerifiedMaster } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
const json = (body: unknown, status = 200) => NextResponse.json(body, {
  status,
  headers: { "Cache-Control": "no-store, max-age=0" },
});

type MasterAuthorization =
  | { authorized: true; master: NonNullable<Awaited<ReturnType<typeof getVerifiedMaster>>> }
  | { authorized: false; response: NextResponse };

async function authorize(request: NextRequest): Promise<MasterAuthorization> {
  const master = await getVerifiedMaster(request.headers.get("authorization"));
  return master
    ? { authorized: true, master }
    : { authorized: false, response: json({ error: "Não autorizado." }, 403) };
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const result = await authorize(request);
  if (!result.authorized) return result.response;
  const page = z.coerce.number().int().min(1).max(100_000).safeParse(request.nextUrl.searchParams.get("page") ?? "1");
  if (!page.success) return json({ error: "Página inválida." }, 400);

  const admin = getSupabaseAdminClient();
  const { data, error } = await admin.rpc("master_list_access_invites", {
    p_actor_id: result.master.id,
    p_page: page.data,
    p_page_size: 25,
  });
  if (error || !data) return json({ error: "Não foi possível carregar os convites." }, 503);
  return json({ ...data, items: (data.items ?? []).map((invite: { token: string; status: string; [key: string]: unknown }) => {
    const { token, ...safeInvite } = invite;
    return {
      ...safeInvite,
      // A token only has value while the invitation can still be redeemed.
      // Never send revoked, expired, or already-used invitation secrets back.
      link: invite.status === "active" ? `${request.nextUrl.origin}/?invite=${encodeURIComponent(token)}` : "",
    };
  }) });
}

export async function POST(request: NextRequest) {
  const result = await authorize(request);
  if (!result.authorized) return result.response;

  const admin = getSupabaseAdminClient();
  const { data, error } = await admin.rpc("master_create_access_invite", { p_actor_id: result.master.id });
  if (error || !data) return json({ error: "Não foi possível gerar o convite." }, 503);
  return json({
    invite: {
      ...data,
      link: `${request.nextUrl.origin}/?invite=${encodeURIComponent(data.token)}`,
    },
  }, 201);
}

export async function DELETE(request: NextRequest) {
  const result = await authorize(request);
  if (!result.authorized) return result.response;
  const payload = z.object({ inviteId: z.string().uuid() }).safeParse(await request.json().catch(() => null));
  if (!payload.success) return json({ error: "Convite inválido." }, 400);

  const admin = getSupabaseAdminClient();
  const { data, error } = await admin.rpc("master_revoke_access_invite", {
    p_actor_id: result.master.id,
    p_invite_id: payload.data.inviteId,
  });
  if (error) return json({ error: "Não foi possível cancelar este convite. Ele pode já ter expirado ou sido utilizado." }, 409);
  if (!data) return json({ error: "O convite não foi cancelado." }, 409);
  return json({ ok: true });
}
