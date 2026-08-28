import { describe, expect, it } from "vitest";
import type { GenerateContentResponse } from "@google/genai";
import { buildPlannerRequest, SYSTEM_PROMPT } from "../prompts.js";
import { fromGeminiResponse, GEMINI_PLANNER_MODEL, toGeminiRequest } from "./gemini.js";

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

describe("the Gemini request conversion", () => {
  const request = toGeminiRequest(buildPlannerRequest([{ role: "user", content: "Task text" }]));

  it("carries the frozen system prompt and every tool schema", () => {
    if (typeof request.config?.systemInstruction !== "string") throw new Error("no system text");
    expect(request.config.systemInstruction).toBe(SYSTEM_PROMPT);
    expect(request.model).toBe(GEMINI_PLANNER_MODEL);
    expect(request.config.maxOutputTokens).toBe(64_000);
    const source = buildPlannerRequest([]).tools ?? [];
    const declarations = (
      request.config.tools as { functionDeclarations: { name: string; parametersJsonSchema: unknown }[] }[]
    )[0]?.functionDeclarations;
    expect(declarations).toHaveLength(source.length);
    for (const [index, declaration] of (declarations ?? []).entries()) {
      const original = source[index];
      if (original === undefined || !("input_schema" in original)) throw new Error("tool mismatch");
      expect(declaration.name).toBe(original.name);
      expect(declaration.parametersJsonSchema).toEqual(original.input_schema);
    }
  });

  it("maps history onto contents, recovering the function name for results", () => {
    const request = toGeminiRequest(
      buildPlannerRequest([
        { role: "user", content: "Task text" },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "g-abc",
              name: "page_action",
              input: { a: 1 },
              caller: { type: "direct" },
            },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "g-abc", content: "it failed", is_error: true },
          ],
        },
      ]),
    );
    expect(request.contents).toEqual([
      { role: "user", parts: [{ text: "Task text" }] },
      {
        role: "model",
        parts: [{ functionCall: { id: "abc", name: "page_action", args: { a: 1 } } }],
      },
      {
        role: "user",
        parts: [
          {
            functionResponse: {
              id: "abc",
              name: "page_action",
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
              parts: [
                {
                  functionCall: { name: "finish", args: {} },
                  thoughtSignature: "sig-1",
                },
              ],
            },
          },
        ],
        usageMetadata: USAGE,
      }),
    );
    const replay = toGeminiRequest(
      buildPlannerRequest([{ role: "assistant", content: message.content }]),
    );
    expect(replay.contents).toEqual([
      {
        role: "model",
        parts: [{ functionCall: { name: "finish", args: {} }, thoughtSignature: "sig-1" }],
      },
    ]);
  });
});

describe("the Gemini response conversion", () => {
  it("maps a function call to a tool_use block and stop_reason tool_use", () => {
    const message = fromGeminiResponse(
      fakeResponse({
        candidates: [
          {
            finishReason: "STOP",
            content: {
              role: "model",
              parts: [{ functionCall: { id: "abc", name: "page_action", args: { x: "y" } } }],
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
        name: "page_action",
        input: { x: "y" },
        caller: { type: "direct" },
      },
    ]);
    expect(message.usage.cache_read_input_tokens).toBe(500);
    expect(message.usage.input_tokens).toBe(700);
    expect(message.usage.output_tokens).toBe(42);
  });

  it("maps a safety stop to a refusal with refusal stop details", () => {
    const message = fromGeminiResponse(
      fakeResponse({
        candidates: [{ finishReason: "SAFETY", content: { role: "model", parts: [] } }],
        usageMetadata: USAGE,
      }),
    );
    expect(message.stop_reason).toBe("refusal");
    expect(message.stop_details?.type).toBe("refusal");
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
