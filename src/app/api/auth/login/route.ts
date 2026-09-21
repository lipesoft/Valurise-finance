import { NextResponse } from "next/server";

/**
 * Kept only so older clients receive a clear response while they refresh.
 * Authentication is exclusively handled by Supabase Auth; this route must
 * never validate passwords from deployment environment variables.
 */
export async function POST() {
  return NextResponse.json(
    { error: "Use a autenticação segura da Valurise." },
    { status: 410 },
  );
}
