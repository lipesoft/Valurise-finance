import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdminClient, getVerifiedMaster } from "@/lib/supabase/admin";

export async function POST(request: NextRequest) {
  const master = await getVerifiedMaster(request.headers.get("authorization"));
  if (!master) return NextResponse.json({ error: "Não autorizado." }, { status: 403 });

  const admin = getSupabaseAdminClient();
  const { data, error } = await admin
    .from("access_invites")
    .insert({ created_by: master.id })
    .select("token, expires_at")
    .single();
  if (error || !data) return NextResponse.json({ error: "Não foi possível gerar o convite." }, { status: 500 });

  return NextResponse.json({
    link: `${request.nextUrl.origin}/?invite=${data.token}`,
    expiresAt: data.expires_at,
  });
}
