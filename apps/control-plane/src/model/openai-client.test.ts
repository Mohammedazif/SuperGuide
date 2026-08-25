import { describe, expect, it } from "vitest";
import type { Response } from "openai/resources/responses/responses";
import { buildCachedPrefix } from "./prompt.js";
import type { CompiledTool } from "../tools/compiled.js";
import { fromOpenAIResponse, toOpenAIInput, toOpenAITools } from "./openai-client.js";

function fakeResponse(partial: {
  output: unknown[];
  status?: string;
  incomplete_details?: { reason: string };
  usage?: unknown;
}): Response {
  return {
    id: "resp_1",
    model: "gpt-test",
    status: "completed",
    ...partial,
  } as unknown as Response;
}

const USAGE = {
  input_tokens: 900,
  output_tokens: 40,
  total_tokens: 940,
  input_tokens_details: { cached_tokens: 800, cache_write_tokens: 0 },
  output_tokens_details: { reasoning_tokens: 10 },
};

const TOOL: CompiledTool = {
  name: "api_update_billing",
  description: "Update the billing address",
  inputSchema: {
    type: "object",
    properties: { intent: { type: "string" }, line1: { type: "string" } },
    required: ["intent"],
    additionalProperties: false,
  },
  risk: "write",
  ladderLevel: "L1",
  timeoutMs: 20_000,
  expectTemplate: [{ kind: "http_status", in: [200] }],
  source: {
    kind: "api",
    operationId: "updateBilling",
    method: "POST",
    path: "/api/v1/billing",
    pathParams: [],
    queryParams: [],
    bodyParams: ["line1"],
  },
};

describe("the request conversion", () => {
  it("keeps every compiled tool schema, without strict mode", () => {
    const prefix = buildCachedPrefix({
      productName: "Northwind",
      stepBudget: 12,
      groundedActionsEnabled: false,
      procedure: null,
      tools: [TOOL],
    });
    const tools = toOpenAITools(prefix.tools);
    expect(tools).toHaveLength(1);
    const tool = tools[0];
    if (tool?.type !== "function") throw new Error("expected a function tool");
    expect(tool.name).toBe(TOOL.name);
    expect(tool.strict).toBe(false);
    expect(tool.parameters).toEqual(prefix.tools[0]?.input_schema);
  });

  it("maps the turn history onto input items", () => {
    const input = toOpenAIInput([
      { role: "user", content: "Task text" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "I will act." },
          { type: "tool_use", id: "call_1", name: "api_update_billing", input: { a: 1 } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_1", content: "it failed", is_error: true },
        ],
      },
    ]);
    expect(input).toEqual([
      { type: "message", role: "user", content: "Task text" },
      { type: "message", role: "assistant", content: "I will act." },
      { type: "function_call", call_id: "call_1", name: "api_update_billing", arguments: '{"a":1}' },
      { type: "function_call_output", call_id: "call_1", output: "[tool error] it failed" },
    ]);
  });

  it("replays a reasoning item verbatim from its stashed thinking block", () => {
    const message = fromOpenAIResponse(
      fakeResponse({
        output: [
          {
            type: "reasoning",
            id: "rs_1",
            summary: [{ type: "summary_text", text: "thinking" }],
            encrypted_content: "opaque-blob",
          },
          { type: "function_call", call_id: "call_2", name: "finish", arguments: "{}" },
        ],
        usage: USAGE,
      }),
    );
    const replay = toOpenAIInput([{ role: "assistant", content: message.content }]);
    expect(replay).toEqual([
      {
        type: "reasoning",
        id: "rs_1",
        summary: [{ type: "summary_text", text: "thinking" }],
        encrypted_content: "opaque-blob",
      },
      { type: "function_call", call_id: "call_2", name: "finish", arguments: "{}" },
    ]);
  });
});

describe("the response conversion", () => {
  it("maps a function call to a tool_use block and stop_reason tool_use", () => {
    const message = fromOpenAIResponse(
      fakeResponse({
        output: [
          { type: "function_call", call_id: "call_9", name: "api_update_billing", arguments: '{"x":"y"}' },
        ],
        usage: USAGE,
      }),
    );
    expect(message.stop_reason).toBe("tool_use");
    expect(message.content).toEqual([
      {
        type: "tool_use",
        id: "call_9",
        name: "api_update_billing",
        input: { x: "y" },
        caller: { type: "direct" },
      },
    ]);
    expect(message.usage.cache_read_input_tokens).toBe(800);
    expect(message.usage.input_tokens).toBe(900);
    expect(message.usage.output_tokens).toBe(40);
  });

  it("maps a refusal part to stop_reason refusal", () => {
    const message = fromOpenAIResponse(
      fakeResponse({
        output: [
          {
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "refusal", refusal: "I cannot help with that." }],
          },
        ],
        usage: USAGE,
      }),
    );
    expect(message.stop_reason).toBe("refusal");
  });

  it("maps output truncation to stop_reason max_tokens", () => {
    const message = fromOpenAIResponse(
      fakeResponse({
        output: [],
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        usage: USAGE,
      }),
    );
    expect(message.stop_reason).toBe("max_tokens");
  });

  it("maps plain text to an end_turn message", () => {
    const message = fromOpenAIResponse(
      fakeResponse({
        output: [
          {
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "All done.", annotations: [] }],
          },
        ],
        usage: USAGE,
      }),
    );
    expect(message.stop_reason).toBe("end_turn");
    expect(message.content).toEqual([{ type: "text", text: "All done.", citations: null }]);
  });
});
