import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSupabaseAdminClient, getVerifiedActiveUser } from "@/lib/supabase/admin";
import { getVerifiedWorkspaceContext } from "@/lib/workspaces/server";
import { isValidCnpj, normalizeCnpj } from "@/lib/workspaces/cnpj";

const schema = z.object({
  tradeName: z.string().trim().min(2).max(120),
  legalName: z.string().trim().min(2).max(180),
  cnpj: z.string().trim().min(14).max(24),
}).strict();

const deleteSchema = z.object({ confirmationName: z.string().trim().min(1).max(120) }).strict();

function normalizedName(value: string) {
  return value.trim().normalize("NFC").toLocaleLowerCase("pt-BR");
}

export async function POST(request: NextRequest) {
  const user = await getVerifiedActiveUser(request.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Não autorizado." }, { status: 401 });
  if (Number(request.headers.get("content-length") || 0) > 4096) return NextResponse.json({ error: "O cadastro excede o tamanho permitido." }, { status: 413 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Informe nome fantasia, razão social e CNPJ." }, { status: 400 });
  const normalizedCnpj = normalizeCnpj(parsed.data.cnpj);
  if (!isValidCnpj(normalizedCnpj)) return NextResponse.json({ error: "Confira o CNPJ informado." }, { status: 400 });

  const admin = getSupabaseAdminClient();
  const { data, error } = await admin.rpc("create_business_workspace", {
    p_user_id: user.id,
    p_trade_name: parsed.data.tradeName,
    p_legal_name: parsed.data.legalName,
    p_cnpj: normalizedCnpj,
  });
  if (error) {
    if (error.code === "23505") return NextResponse.json({ error: "Já existe um workspace empresarial com esse CNPJ." }, { status: 409 });
    if (error.code === "42P01" || error.code === "PGRST202") return NextResponse.json({ error: "A estrutura multi-workspace ainda não foi aplicada no banco." }, { status: 503 });
    if (error.code === "22023") return NextResponse.json({ error: "Confira os dados empresariais e tente novamente." }, { status: 400 });
    console.error("Business workspace creation failed", JSON.stringify({ code: error.code || "UNKNOWN" }));
    return NextResponse.json({ error: "Não foi possível criar o workspace empresarial." }, { status: 503 });
  }
  return NextResponse.json({ ok: true, workspace: data }, { status: 201, headers: { "Cache-Control": "no-store" } });
}

export async function DELETE(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (origin) {
    try {
      if (new URL(origin).origin !== request.nextUrl.origin) {
        return NextResponse.json({ error: "Solicitação inválida." }, { status: 403 });
      }
    } catch {
      return NextResponse.json({ error: "Solicitação inválida." }, { status: 403 });
    }
  }

  const active = await getVerifiedWorkspaceContext(
    request.headers.get("authorization"),
    request.headers.get("x-valurise-workspace-id"),
  );
  if (!active.ok) return NextResponse.json({ error: active.error }, { status: active.status, headers: { "Cache-Control": "no-store" } });
  if (active.workspace.type !== "business" || active.workspace.role !== "owner") {
    return NextResponse.json({ error: "Somente o proprietário pode excluir uma empresa." }, { status: 403, headers: { "Cache-Control": "no-store" } });
  }
  if (Number(request.headers.get("content-length") || 0) > 2048) {
    return NextResponse.json({ error: "A confirmação excede o tamanho permitido." }, { status: 413 });
  }

  const parsed = deleteSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Digite o nome da empresa para confirmar a exclusão." }, { status: 400 });

  const admin = getSupabaseAdminClient();
  const { data: company, error: companyError } = await admin.from("workspaces")
    .select("id, type, display_name, owner_user_id")
    .eq("id", active.workspace.id)
    .maybeSingle();
  if (companyError) {
    console.error("Business workspace deletion lookup failed", JSON.stringify({ code: companyError.code || "UNKNOWN" }));
    return NextResponse.json({ error: "Não foi possível validar a empresa para exclusão." }, { status: 503 });
  }
  if (!company) return NextResponse.json({ error: "Esta empresa não está mais disponível." }, { status: 404 });
  if (company.type !== "business" || company.owner_user_id !== active.user.id) {
    return NextResponse.json({ error: "Somente o proprietário pode excluir esta empresa." }, { status: 403 });
  }
  if (normalizedName(parsed.data.confirmationName) !== normalizedName(company.display_name)) {
    return NextResponse.json({ error: "O nome informado não corresponde à empresa." }, { status: 400 });
  }

  // The unique personal workspace is the account's original/main workspace.
  // Sorting explicitly keeps this safe even if old data ever contains duplicates.
  const { data: personalWorkspace, error: personalError } = await admin.from("workspaces")
    .select("id, type")
    .eq("owner_user_id", active.user.id)
    .eq("type", "personal")
    .is("archived_at", null)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (personalError) {
    console.error("Personal workspace lookup before company deletion failed", JSON.stringify({ code: personalError.code || "UNKNOWN" }));
    return NextResponse.json({ error: "Não foi possível confirmar seu espaço Pessoal. Nenhum dado foi excluído." }, { status: 503 });
  }
  if (!personalWorkspace || personalWorkspace.id === company.id) {
    return NextResponse.json({ error: "Seu espaço Pessoal não foi encontrado. Nenhum dado foi excluído." }, { status: 409 });
  }

  const { data: activeCollaborator, error: membershipError } = await admin.from("workspace_memberships")
    .select("user_id")
    .eq("workspace_id", company.id)
    .eq("status", "active")
    .neq("user_id", active.user.id)
    .limit(1)
    .maybeSingle();
  if (membershipError) {
    console.error("Business workspace members lookup before deletion failed", JSON.stringify({ code: membershipError.code || "UNKNOWN" }));
    return NextResponse.json({ error: "Não foi possível validar os acessos desta empresa. Nenhum dado foi excluído." }, { status: 503 });
  }
  if (activeCollaborator) {
    return NextResponse.json({ error: "Esta empresa ainda tem outras pessoas com acesso ativo. Remova ou transfira esses acessos antes de excluí-la." }, { status: 409 });
  }

  // Move the saved startup selection first. If deletion is rejected, the company
  // and its data remain intact; the only change is opening the safe personal space.
  const { error: selectionError } = await admin.from("user_active_workspaces").upsert({
    user_id: active.user.id,
    workspace_id: personalWorkspace.id,
    updated_at: new Date().toISOString(),
  }, { onConflict: "user_id" });
  if (selectionError) {
    console.error("Personal workspace selection before company deletion failed", JSON.stringify({ code: selectionError.code || "UNKNOWN" }));
    return NextResponse.json({ error: "Não foi possível preparar a volta ao espaço Pessoal. Nenhum dado foi excluído." }, { status: 503 });
  }

  // Existing workspace foreign keys cascade the deletion through the company's
  // finance state, ledger, profile, assumptions, AI data and workspace settings.
  // The database trigger also blocks a concurrent membership change.
  const { data: deletedWorkspace, error: deleteError } = await admin.from("workspaces")
    .delete()
    .eq("id", company.id)
    .eq("owner_user_id", active.user.id)
    .eq("type", "business")
    .select("id")
    .maybeSingle();
  if (deleteError) {
    console.error("Business workspace deletion failed", JSON.stringify({ code: deleteError.code || "UNKNOWN" }));
    if (deleteError.code === "23503") {
      return NextResponse.json({ error: "A empresa possui outro acesso ativo ou dados vinculados que impedem a exclusão. Nenhum dado foi removido." }, { status: 409 });
    }
    return NextResponse.json({ error: "Não foi possível excluir a empresa. Nenhum dado foi removido." }, { status: 503 });
  }
  if (!deletedWorkspace) return NextResponse.json({ error: "Esta empresa não está mais disponível." }, { status: 404 });

  return NextResponse.json({ ok: true, deletedWorkspaceId: deletedWorkspace.id, personalWorkspaceId: personalWorkspace.id }, { headers: { "Cache-Control": "no-store" } });
}
