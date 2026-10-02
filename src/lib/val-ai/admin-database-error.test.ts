import { describe, expect, it } from "vitest";
import { diagnoseValAIAdminDatabaseError } from "./admin-database-error";

describe("diagnóstico da leitura administrativa da Central da Val", () => {
  it("distingue banco indisponível de migration ausente", () => {
    expect(diagnoseValAIAdminDatabaseError({ message: "Connection terminated due to connection timeout" })).toMatchObject({
      code: "VAL_AI_DATABASE_UNAVAILABLE",
      message: expect.stringContaining("projeto Supabase está ativo"),
    });
  });

  it("orienta aplicar migrations apenas para erros de schema", () => {
    expect(diagnoseValAIAdminDatabaseError({ code: "42P01", message: "relation does not exist" })).toMatchObject({
      code: "VAL_AI_MIGRATION_REQUIRED",
      message: expect.stringContaining("migrations pendentes"),
    });
    expect(diagnoseValAIAdminDatabaseError({ code: "PGRST205", message: "table not found in schema cache" }).code).toBe("VAL_AI_MIGRATION_REQUIRED");
  });

  it("não classifica um erro administrativo genérico como migration ausente", () => {
    const diagnosis = diagnoseValAIAdminDatabaseError({ code: "42501", message: "permission denied" });
    expect(diagnosis.code).toBe("VAL_AI_ADMIN_READ_FAILED");
    expect(diagnosis.technical).toContain("42501");
  });

  it("limita o detalhe técnico retornado ao Super Admin", () => {
    expect(diagnoseValAIAdminDatabaseError({ message: "x".repeat(500) }).technical).toHaveLength(300);
  });
});
