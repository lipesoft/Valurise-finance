/**
 * DeepSeek defaults to thinking mode. Its API does not accept `tool_choice:
 * required` in that mode, so disable thinking only on calls that must invoke a
 * tool. Normal conversational calls retain the provider default.
 */
export function getValProviderOptions(requiresTools: boolean) {
  return requiresTools
    ? { deepseek: { thinking: { type: "disabled" as const } } }
    : undefined;
}
