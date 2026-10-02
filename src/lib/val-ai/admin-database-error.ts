export type ValAIAdminDatabaseError = {
  code?: string | null;
  message?: string | null;
};

export type ValAIAdminDatabaseDiagnosis = {
  code: "VAL_AI_DATABASE_UNAVAILABLE" | "VAL_AI_MIGRATION_REQUIRED" | "VAL_AI_ADMIN_READ_FAILED";
  message: string;
  technical: string;
};

const missingSchemaCodes = new Set(["42P01", "42703", "PGRST204", "PGRST205"]);
const unavailableCodes = new Set(["08000", "08003", "08006", "57P01", "PGRST000", "PGRST001", "PGRST002"]);
const unavailableMessage = /fetch failed|connection (?:terminated|refused|closed|timeout)|timed? ?out|could not connect|network error|server closed the connection|temporarily unavailable/i;

export function diagnoseValAIAdminDatabaseError(error: ValAIAdminDatabaseError): ValAIAdminDatabaseDiagnosis {
  const databaseCode = error.code?.trim() || null;
  const databaseMessage = error.message?.trim() || "Erro sem detalhe retornado pelo banco.";
  const technical = `${databaseCode ? `${databaseCode}: ` : ""}${databaseMessage}`.slice(0, 300);

  if ((databaseCode && unavailableCodes.has(databaseCode)) || unavailableMessage.test(databaseMessage)) {
    return {
      code: "VAL_AI_DATABASE_UNAVAILABLE",
      message: "O banco da Central da Val não está respondendo. Confira se o projeto Supabase está ativo e tente novamente.",
      technical,
    };
  }

  if (databaseCode && missingSchemaCodes.has(databaseCode)) {
    return {
      code: "VAL_AI_MIGRATION_REQUIRED",
      message: "O schema da Central da Val está incompleto ou desatualizado. Confira e aplique as migrations pendentes do repositório.",
      technical,
    };
  }

  return {
    code: "VAL_AI_ADMIN_READ_FAILED",
    message: "Não foi possível consultar os dados da Central da Val.",
    technical,
  };
}
