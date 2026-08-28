import { describe, expect, it } from "vitest";
import type { Response } from "openai/resources/responses/responses";
import { buildPlannerRequest, SYSTEM_PROMPT } from "../prompts.js";
import { fromOpenAIResponse, OPENAI_PLANNER_MODEL, toOpenAIRequest } from "./openai.js";

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

describe("the OpenAI request conversion", () => {
  const request = toOpenAIRequest(buildPlannerRequest([{ role: "user", content: "Task text" }]));

  it("carries the frozen system prompt as instructions", () => {
    expect(request.instructions).toBe(SYSTEM_PROMPT);
    expect(request.model).toBe(OPENAI_PLANNER_MODEL);
    expect(request.max_output_tokens).toBe(64_000);
    expect(request.parallel_tool_calls).toBe(false);
    expect(request.store).toBe(false);
  });

  it("maps every agent tool to a strict function tool with its schema intact", () => {
    const source = buildPlannerRequest([]).tools ?? [];
    expect(request.tools).toHaveLength(source.length);
    for (const [index, tool] of (request.tools ?? []).entries()) {
      const original = source[index];
      if (original === undefined || !("input_schema" in original) || tool.type !== "function") {
        throw new Error("tool shape mismatch");
      }
      expect(tool.name).toBe(original.name);
      expect(tool.strict).toBe(true);
      expect(tool.parameters).toEqual(original.input_schema);
    }
  });

  it("maps the turn history onto input items", () => {
    const history = toOpenAIRequest(
      buildPlannerRequest([
        { role: "user", content: "Task text" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "I will act.", citations: null },
            {
              type: "tool_use",
              id: "call_1",
              name: "page_action",
              input: { a: 1 },
              caller: { type: "direct" },
            },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "call_1", content: "it failed", is_error: true },
          ],
        },
      ]),
    );
    expect(history.input).toEqual([
      { type: "message", role: "user", content: "Task text" },
      { type: "message", role: "assistant", content: "I will act." },
      { type: "function_call", call_id: "call_1", name: "page_action", arguments: '{"a":1}' },
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
    const replay = toOpenAIRequest(
      buildPlannerRequest([{ role: "assistant", content: message.content }]),
    );
    expect(replay.input).toEqual([
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

describe("the OpenAI response conversion", () => {
  it("maps a function call to a tool_use block and stop_reason tool_use", () => {
    const message = fromOpenAIResponse(
      fakeResponse({
        output: [
          { type: "function_call", call_id: "call_9", name: "page_action", arguments: '{"x":"y"}' },
        ],
        usage: USAGE,
      }),
    );
    expect(message.stop_reason).toBe("tool_use");
    expect(message.content).toEqual([
      {
        type: "tool_use",
        id: "call_9",
        name: "page_action",
        input: { x: "y" },
        caller: { type: "direct" },
      },
    ]);
    expect(message.usage.cache_read_input_tokens).toBe(800);
    expect(message.usage.input_tokens).toBe(900);
    expect(message.usage.output_tokens).toBe(40);
  });

  it("maps a refusal part to stop_reason refusal with refusal stop details", () => {
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
    expect(message.stop_details?.type).toBe("refusal");
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
