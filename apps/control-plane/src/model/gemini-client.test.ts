import { describe, expect, it } from "vitest";
import type { GenerateContentResponse } from "@google/genai";
import { fromGeminiResponse, toGeminiContents } from "./gemini-client.js";

function fakeResponse(partial: {
  candidates?: unknown[];
  usageMetadata?: unknown;
}): GenerateContentResponse {
  return partial as unknown as GenerateContentResponse;
}

const USAGE = {
  promptTokenCount: 700,
  candidatesTokenCount: 30,
  thoughtsTokenCount: 12,
  cachedContentTokenCount: 500,
};

describe("the request conversion", () => {
  it("maps history onto contents, recovering the function name for results", () => {
    const contents = toGeminiContents([
      { role: "user", content: "Task text" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "g-abc", name: "api_update_billing", input: { a: 1 } }],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "g-abc", content: "it failed", is_error: true },
        ],
      },
    ]);
    expect(contents).toEqual([
      { role: "user", parts: [{ text: "Task text" }] },
      {
        role: "model",
        parts: [{ functionCall: { id: "abc", name: "api_update_billing", args: { a: 1 } } }],
      },
      {
        role: "user",
        parts: [
          {
            functionResponse: {
              id: "abc",
              name: "api_update_billing",
              response: { output: "it failed", error: true },
            },
          },
        ],
      },
    ]);
  });

  it("omits synthetic call ids from the wire and keeps thought signatures attached", () => {
    const message = fromGeminiResponse(
      fakeResponse({
        candidates: [
          {
            finishReason: "STOP",
            content: {
              role: "model",
              parts: [{ functionCall: { name: "finish", args: {} }, thoughtSignature: "sig-1" }],
            },
          },
        ],
        usageMetadata: USAGE,
      }),
    );
    const replay = toGeminiContents([{ role: "assistant", content: message.content }]);
    expect(replay).toEqual([
      {
        role: "model",
        parts: [{ functionCall: { name: "finish", args: {} }, thoughtSignature: "sig-1" }],
      },
    ]);
  });
});

describe("the response conversion", () => {
  it("maps a function call to a tool_use block and stop_reason tool_use", () => {
    const message = fromGeminiResponse(
      fakeResponse({
        candidates: [
          {
            finishReason: "STOP",
            content: {
              role: "model",
              parts: [{ functionCall: { id: "abc", name: "api_update_billing", args: { x: "y" } } }],
            },
          },
        ],
        usageMetadata: USAGE,
      }),
    );
    expect(message.stop_reason).toBe("tool_use");
    expect(message.content).toEqual([
      {
        type: "tool_use",
        id: "g-abc",
        name: "api_update_billing",
        input: { x: "y" },
        caller: { type: "direct" },
      },
    ]);
    expect(message.usage.cache_read_input_tokens).toBe(500);
    expect(message.usage.input_tokens).toBe(700);
    expect(message.usage.output_tokens).toBe(42);
  });

  it("maps a safety stop to a refusal", () => {
    const message = fromGeminiResponse(
      fakeResponse({
        candidates: [{ finishReason: "SAFETY", content: { role: "model", parts: [] } }],
        usageMetadata: USAGE,
      }),
    );
    expect(message.stop_reason).toBe("refusal");
  });

  it("maps an empty candidate list to a refusal", () => {
    const message = fromGeminiResponse(fakeResponse({ usageMetadata: USAGE }));
    expect(message.stop_reason).toBe("refusal");
  });

  it("maps MAX_TOKENS to stop_reason max_tokens and thoughts to thinking blocks", () => {
    const message = fromGeminiResponse(
      fakeResponse({
        candidates: [
          {
            finishReason: "MAX_TOKENS",
            content: {
              role: "model",
              parts: [{ thought: true, text: "planning", thoughtSignature: "sig-2" }],
            },
          },
        ],
        usageMetadata: USAGE,
      }),
    );
    expect(message.stop_reason).toBe("max_tokens");
    expect(message.content).toEqual([
      { type: "thinking", thinking: "planning", signature: '{"sig":"sig-2"}' },
    ]);
  });
});
