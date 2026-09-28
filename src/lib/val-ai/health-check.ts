export const VAL_HEALTH_CHECK_TOOL_NAME = "getHealthCheckValue";
export const VAL_HEALTH_CHECK_TOOL_DESCRIPTION = "Retorna um sinal fictício local de saúde, sem dados e sem efeitos colaterais.";

export function getValHealthCheckPrompt(requiresTool: boolean) {
  return requiresTool
    ? `Chame a ferramenta ${VAL_HEALTH_CHECK_TOOL_NAME} exatamente uma vez, usando os argumentos vazios. Esta é apenas uma verificação técnica, sem consulta a dados.`
    : "Responda somente: OK.";
}

export function isValHealthCheckSuccessful(
  result: { text: string; steps: Array<{ toolCalls: Array<{ toolName: string }> }> },
  requiresTool: boolean,
) {
  if (!requiresTool) return Boolean(result.text.trim());
  return result.steps.flatMap((step) => step.toolCalls).some((call) => call.toolName === VAL_HEALTH_CHECK_TOOL_NAME);
}
