import type Anthropic from "@anthropic-ai/sdk";
import type { z } from "zod";
import { TurnFailure } from "../errors.js";
import type {
  ClassifyRequest,
  GenerateRequest,
  GenerateResult,
  ModelClient,
  ModelUsage,
} from "./client.js";

export interface ScriptedTurn {
  text?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  usage?: Partial<ModelUsage>;
  latencyMs?: number;
}

export interface ScriptedModelClientOptions {
  script: readonly ScriptedTurn[];
  classifications?: readonly unknown[];
}

export class ScriptedModelClient implements ModelClient {
  readonly requests: GenerateRequest[] = [];
  readonly #script: readonly ScriptedTurn[];
  readonly #classifications: readonly unknown[];
  #generateIndex = 0;
  #classifyIndex = 0;

  constructor(options: ScriptedModelClientOptions) {
    this.#script = options.script;
    this.#classifications = options.classifications ?? [];
  }

  generate(request: GenerateRequest): Promise<GenerateResult> {
    this.requests.push(request);
    const turn = this.#script[this.#generateIndex];
    this.#generateIndex += 1;

    if (turn === undefined) {
      return Promise.reject(
        new TurnFailure("script_exhausted", "the recorded transcript ran out of turns"),
      );
    }

    if (turn.text !== undefined && turn.text.length > 0) request.onTextDelta?.(turn.text);

    const content: Anthropic.ContentBlock[] = [];
    if (turn.text !== undefined && turn.text.length > 0) {
      content.push({ type: "text", text: turn.text, citations: null });
    }
    if (turn.toolName !== undefined) {
      content.push({
        type: "tool_use",
        id: `toolu_scripted_${String(this.#generateIndex)}`,
        name: turn.toolName,
        input: turn.toolInput ?? {},
        caller: { type: "direct" },
      });
    }

    const usage: ModelUsage = {
      inputTokens: turn.usage?.inputTokens ?? 1200,
      outputTokens: turn.usage?.outputTokens ?? 90,
      cacheReadTokens: turn.usage?.cacheReadTokens ?? (this.#generateIndex > 1 ? 1100 : 0),
      cacheCreationTokens: turn.usage?.cacheCreationTokens ?? (this.#generateIndex === 1 ? 1100 : 0),
    };

    const message: Anthropic.Message = {
      id: `msg_scripted_${String(this.#generateIndex)}`,
      type: "message",
      role: "assistant",
      model: request.model,
      content,
      stop_reason: turn.toolName === undefined ? "end_turn" : "tool_use",
      stop_sequence: null,
      stop_details: null,
      usage: {
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
        cache_read_input_tokens: usage.cacheReadTokens,
        cache_creation_input_tokens: usage.cacheCreationTokens,
        cache_creation: null,
        server_tool_use: null,
        service_tier: null,
        inference_geo: null,
        output_tokens_details: null,
      },
      container: null,
    };

    return Promise.resolve({ message, usage, latencyMs: turn.latencyMs ?? 40 });
  }

  classify<Shape extends z.ZodType>(request: ClassifyRequest<Shape>): Promise<z.infer<Shape>> {
    const value = this.#classifications[this.#classifyIndex];
    this.#classifyIndex += 1;
    if (value === undefined) {
      return Promise.reject(
        new TurnFailure("script_exhausted", "the recorded transcript has no classification left"),
      );
    }
    return Promise.resolve(request.schema.parse(value));
  }
}
