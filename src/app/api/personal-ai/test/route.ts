import { NextRequest, NextResponse } from "next/server";
import { getVerifiedWorkspaceContext } from "@/lib/workspaces/server";

/** Individual/provider test endpoints are retired; only Super Admin may test the central DeepSeek setup. */
export async function POST(request: NextRequest) {
  const active = await getVerifiedWorkspaceContext(request.headers.get("authorization"), request.headers.get("x-valurise-workspace-id"));
  if (!active.ok) return NextResponse.json({ error: active.error }, { status: active.status });
  return NextResponse.json({ error: "Os testes de conexão são administrados exclusivamente no Super Admin." }, { status: 410, headers: { "Cache-Control": "no-store" } });
}
