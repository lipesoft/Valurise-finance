import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, isStepCount, tool } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { getValProviderOptions } from "./provider-options";

describe("Val DeepSeek request options", () => {
  it("disables thinking only when a tool call is required", () => {
    expect(getValProviderOptions(true)).toEqual({ deepseek: { thinking: { type: "disabled" } } });
    expect(getValProviderOptions(false)).toBeUndefined();
  });

  it("sends DeepSeek's non-thinking mode with required tool choice", async () => {
    let requestBody: Record<string, unknown> | null = null;
    const provider = createOpenAICompatible({
      name: "deepseek",
      apiKey: "test-key-never-used",
      baseURL: "https://api.deepseek.com",
      fetch: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({
          id: "test-response",
          object: "chat.completion",
          created: 1,
          model: "deepseek-flash",
          choices: [{
            index: 0,
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{ id: "call-health", type: "function", function: { name: "getHealthCheckValue", arguments: "{}" } }],
            },
          }],
          usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
        }), { headers: { "Content-Type": "application/json" } });
      },
    });

    await generateText({
      model: provider("deepseek-flash"),
      prompt: "Call the health check tool.",
      tools: {
        getHealthCheckValue: tool({
          description: "Returns a local health signal.",
          inputSchema: z.object({}).strict(),
          execute: async () => ({ ok: true }),
        }),
      },
      toolChoice: "required",
      providerOptions: getValProviderOptions(true),
      stopWhen: isStepCount(1),
      maxOutputTokens: 32,
    });

    expect(requestBody).toMatchObject({
      tool_choice: "required",
      thinking: { type: "disabled" },
    });
  });
});
