export const VAL_HEALTH_CHECK_TOOL_NAME = "getHealthCheckValue";
export const VAL_HEALTH_CHECK_TOOL_DESCRIPTION = "Retorna um sinal fictício local de saúde, sem dados e sem efeitos colaterais.";

export function getValHealthCheckPrompt(requiresTool: boolean) {
  return requiresTool
    ? `Chame a ferramenta ${VAL_HEALTH_CHECK_TOOL_NAME} exatamente uma vez, usando os argumentos vazios. Depois que ela retornar, responda somente: OK.`
    : "Responda somente: OK.";
}
