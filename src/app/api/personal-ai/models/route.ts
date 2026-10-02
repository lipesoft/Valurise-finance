import { NextRequest, NextResponse } from "next/server";
import { getVerifiedWorkspaceContext } from "@/lib/workspaces/server";

/** Personal catalog discovery is retired; the Central da Val manages DeepSeek models. */
export async function POST(request: NextRequest) {
  const active = await getVerifiedWorkspaceContext(request.headers.get("authorization"), request.headers.get("x-valurise-workspace-id"));
  if (!active.ok) return NextResponse.json({ error: active.error }, { status: active.status });
  return NextResponse.json({ error: "A configuração de modelos é administrada centralmente pela Valurise." }, { status: 410, headers: { "Cache-Control": "no-store" } });
}
