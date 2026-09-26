import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { BUSINESS_ASSUMPTION_KEYS } from "@/lib/business-finance";
import { createUserScopedSupabaseClient } from "@/lib/supabase/user-scoped";
import { getVerifiedWorkspaceContext } from "@/lib/workspaces/server";

export const dynamic = "force-dynamic";

const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const optionalText = (max: number) => z.string().trim().max(max).nullable();
const companySchema = z.object({
  email: z.union([z.string().trim().email().max(254), z.literal("")]).nullable(),
  phone: optionalText(32),
  postal_code: optionalText(12),
  street: optionalText(160),
  number: optionalText(30),
  address_complement: optionalText(100),
  neighborhood: optionalText(100),
  city: optionalText(100),
  state: optionalText(2),
  activity_start_date: z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.literal("")]).nullable(),
  cnae: z.union([z.string().regex(/^\d{7}$/), z.literal("")]).nullable(),
  tax_regime: z.enum(["mei", "simples_nacional", "lucro_presumido", "lucro_real", "other"]).nullable(),
  accountant_name: optionalText(120),
  management_close_day: z.number().int().min(1).max(31).nullable(),
  default_currency: z.string().regex(/^[A-Z]{3}$/),
  timezone: z.string().trim().min(1).max(80),
}).strict();

const financialSchema = z.object({
  referenceMonth: monthSchema,
  requestId: z.string().uuid(),
  assumptions: z.array(z.object({
    metricKey: z.enum(BUSINESS_ASSUMPTION_KEYS),
    amountCents: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
    nature: z.enum(["reported", "estimated"]),
  }).strict()).length(BUSINESS_ASSUMPTION_KEYS.length),
}).strict();

const patchSchema = z.discriminatedUnion("section", [
  z.object({ section: z.literal("company"), profile: companySchema }).strict(),
  z.object({ section: z.literal("finance"), ...financialSchema.shape }).strict(),
]);

function bearerToken(request: NextRequest) {
  return request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim() || "";
}

function latestAssumption(client: ReturnType<typeof createUserScopedSupabaseClient>, workspaceId: string, metricKey: typeof BUSINESS_ASSUMPTION_KEYS[number], referenceMonth: string) {
  return client.from("business_financial_assumptions")
    .select("metric_key, amount_cents, nature, source, reference_month, is_cleared, created_at")
    .eq("workspace_id", workspaceId)
    .eq("metric_key", metricKey)
    .lte("reference_month", `${referenceMonth}-01`)
    .order("reference_month", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
}

export async function GET(request: NextRequest) {
  const active = await getVerifiedWorkspaceContext(request.headers.get("authorization"), request.headers.get("x-valurise-workspace-id"));
  if (!active.ok) return NextResponse.json({ error: active.error }, { status: active.status });
  if (active.workspace.type !== "business") return NextResponse.json({ error: "Este perfil existe somente em espaços empresariais." }, { status: 403 });
  const suppliedMonth = request.nextUrl.searchParams.get("month") || new Date().toISOString().slice(0, 7);
  const parsedMonth = monthSchema.safeParse(suppliedMonth);
  if (!parsedMonth.success) return NextResponse.json({ error: "Informe um período válido." }, { status: 400 });
  try {
    const client = createUserScopedSupabaseClient(bearerToken(request));
    const [profileResult, ...assumptionResults] = await Promise.all([
      client.from("business_profiles")
        .select("workspace_id, legal_name, trade_name, cnpj, email, phone, postal_code, street, number, address_complement, neighborhood, city, state, activity_start_date, cnae, tax_regime, accountant_name, management_close_day, default_currency, timezone")
        .eq("workspace_id", active.workspace.id).maybeSingle(),
      ...BUSINESS_ASSUMPTION_KEYS.map((key) => latestAssumption(client, active.workspace.id, key, parsedMonth.data)),
    ]);
    if (profileResult.error || !profileResult.data) return NextResponse.json({ error: "Não foi possível carregar o cadastro da empresa. Confira se a migration de perfil empresarial foi aplicada." }, { status: 503 });
    const assumptions = Object.fromEntries(BUSINESS_ASSUMPTION_KEYS.map((key, index) => {
      const result = assumptionResults[index];
      if (result.error) throw new Error("assumption-query-failed");
      const row = result.data;
      return [key, !row || row.is_cleared ? null : {
        metricKey: row.metric_key,
        amountCents: Number(row.amount_cents),
        nature: row.nature,
        source: row.source,
        referenceMonth: row.reference_month,
        createdAt: row.created_at,
      }];
    }));
    return NextResponse.json({ profile: profileResult.data, assumptions, referenceMonth: parsedMonth.data }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    console.error("Business financial profile read failed", JSON.stringify({ code: error instanceof Error ? error.message : "UNKNOWN" }));
    return NextResponse.json({ error: "Não foi possível consultar o perfil financeiro da empresa." }, { status: 503 });
  }
}

export async function PATCH(request: NextRequest) {
  const active = await getVerifiedWorkspaceContext(request.headers.get("authorization"), request.headers.get("x-valurise-workspace-id"));
  if (!active.ok) return NextResponse.json({ error: active.error }, { status: active.status });
  if (active.workspace.type !== "business") return NextResponse.json({ error: "Este perfil existe somente em espaços empresariais." }, { status: 403 });
  if (!["owner", "admin", "finance"].includes(active.workspace.role)) return NextResponse.json({ error: "Seu perfil pode visualizar, mas não editar os dados financeiros desta empresa." }, { status: 403 });
  if (Number(request.headers.get("content-length") || 0) > 12_000) return NextResponse.json({ error: "Os dados excedem o tamanho permitido." }, { status: 413 });
  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Confira os dados empresariais e os valores informados." }, { status: 400 });
  try {
    const client = createUserScopedSupabaseClient(bearerToken(request));
    if (parsed.data.section === "company") {
      const profile = parsed.data.profile;
      if (profile.timezone) {
        try { new Intl.DateTimeFormat("pt-BR", { timeZone: profile.timezone }); }
        catch { return NextResponse.json({ error: "Informe um fuso horário válido." }, { status: 400 }); }
      }
      if (profile.activity_start_date) {
        const [year, month, day] = profile.activity_start_date.split("-").map(Number);
        const date = new Date(Date.UTC(year, month - 1, day));
        if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
          return NextResponse.json({ error: "Informe uma data de início válida." }, { status: 400 });
        }
      }
      const { data: updatedProfile, error } = await client.from("business_profiles").update({
        ...profile,
        email: profile.email || null,
        activity_start_date: profile.activity_start_date || null,
        cnae: profile.cnae || null,
        updated_at: new Date().toISOString(),
      }).eq("workspace_id", active.workspace.id).select("workspace_id").maybeSingle();
      if (error || !updatedProfile) {
        console.error("Business company profile update failed", JSON.stringify({ code: error?.code || (updatedProfile ? "UNKNOWN" : "NO_MATCHING_PROFILE") }));
        return NextResponse.json({
          error: "Não foi possível confirmar a atualização dos dados cadastrais da empresa.",
        }, { status: error ? 503 : 404 });
      }
      return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
    }

    const financialData = parsed.data as { referenceMonth: string; requestId: string; assumptions: z.infer<typeof financialSchema>["assumptions"] };
    const requestId = financialData.requestId;
    const currentRows = await Promise.all(BUSINESS_ASSUMPTION_KEYS.map((key) => latestAssumption(client, active.workspace.id, key, financialData.referenceMonth)));
    if (currentRows.some((result) => result.error)) return NextResponse.json({ error: "Não foi possível conferir os valores atuais antes de salvar." }, { status: 503 });
    const inserts = financialData.assumptions.flatMap((item, index) => {
      const current = currentRows[index].data;
      const unchanged = item.amountCents === null
        ? !current || current.is_cleared
        : current && !current.is_cleared && Number(current.amount_cents) === item.amountCents && current.nature === item.nature;
      if (unchanged) return [];
      return [{
        workspace_id: active.workspace.id,
        metric_key: item.metricKey,
        amount_cents: item.amountCents ?? 0,
        nature: item.nature,
        source: "manual",
        reference_month: `${financialData.referenceMonth}-01`,
        is_cleared: item.amountCents === null,
        request_id: requestId,
      }];
    });
    if (inserts.length) {
      const { error } = await client.from("business_financial_assumptions").upsert(inserts, {
        onConflict: "workspace_id,request_id,metric_key",
        ignoreDuplicates: true,
      });
      if (error) {
        console.error("Business financial assumptions save failed", JSON.stringify({ code: error.code || "UNKNOWN" }));
        return NextResponse.json({ error: "Não foi possível salvar as estimativas financeiras." }, { status: 503 });
      }
    }
    return NextResponse.json({ ok: true, saved: inserts.length }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Business profile update failed", JSON.stringify({ code: error instanceof Error ? error.message : "UNKNOWN" }));
    return NextResponse.json({ error: "Não foi possível salvar o perfil empresarial." }, { status: 503 });
  }
}
