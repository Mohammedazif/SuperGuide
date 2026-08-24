import Anthropic from "@anthropic-ai/sdk";
import type { z } from "zod";
import type { EffortLevel } from "./routing.js";
import { TurnFailure } from "../errors.js";

export const MAX_OUTPUT_TOKENS = 64_000;

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface GenerateRequest {
  model: string;
  effort: EffortLevel;
  system: Anthropic.TextBlockParam[];
  tools: Anthropic.Tool[];
  messages: Anthropic.MessageParam[];
  signal: AbortSignal;
  onTextDelta?: (text: string) => void;
}

export interface GenerateResult {
  message: Anthropic.Message;
  usage: ModelUsage;
  latencyMs: number;
}

export interface ClassifyRequest<Shape extends z.ZodType> {
  model: string;
  effort: EffortLevel;
  system: string;
  prompt: string;
  schema: Shape;
  signal: AbortSignal;
}

export interface ModelClient {
  generate(request: GenerateRequest): Promise<GenerateResult>;
  classify<Shape extends z.ZodType>(request: ClassifyRequest<Shape>): Promise<z.infer<Shape>>;
}

function emptyUsage(): ModelUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
}

function readUsage(usage: Anthropic.Usage): ModelUsage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
  };
}

function addUsage(left: ModelUsage, right: ModelUsage): ModelUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheCreationTokens: left.cacheCreationTokens + right.cacheCreationTokens,
  };
}

export interface AnthropicModelClientOptions {
  apiKey: string;
  maxPauseContinuations?: number;
  now?: () => number;
}

export class AnthropicModelClient implements ModelClient {
  readonly #client: Anthropic;
  readonly #maxPauseContinuations: number;
  readonly #now: () => number;

  constructor(options: AnthropicModelClientOptions) {
    this.#client = new Anthropic({ apiKey: options.apiKey });
    this.#maxPauseContinuations = options.maxPauseContinuations ?? 4;
    this.#now = options.now ?? (() => Date.now());
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    const startedAt = this.#now();
    const messages = [...request.messages];
    let usage = emptyUsage();

    for (let attempt = 0; attempt <= this.#maxPauseContinuations; attempt += 1) {
      const message = await this.#stream(request, messages, (text) => {
        request.onTextDelta?.(text);
      });
      usage = addUsage(usage, readUsage(message.usage));

      // A paused turn is continued by appending the assistant turn and asking again.
      if (message.stop_reason === "pause_turn") {
        messages.push({ role: "assistant", content: message.content });
        continue;
      }

      return { message, usage, latencyMs: this.#now() - startedAt };
    }

    throw new TurnFailure(
      "pause_turn_not_resolved",
      `the model paused ${this.#maxPauseContinuations + 1} times without producing a turn`,
    );
  }

  async #stream(
    request: GenerateRequest,
    messages: Anthropic.MessageParam[],
    onTextDelta: (text: string) => void,
  ): Promise<Anthropic.Message> {
    try {
      const stream = this.#client.messages.stream(
        {
          model: request.model,
          max_tokens: MAX_OUTPUT_TOKENS,
          system: request.system,
          tools: request.tools,
          messages,
          thinking: { type: "adaptive" },
          output_config: { effort: request.effort },
        },
        { signal: request.signal },
      );

      stream.on("text", onTextDelta);
      return await stream.finalMessage();
    } catch (error) {
      throw describeModelError(error);
    }
  }

  async classify<Shape extends z.ZodType>(
    request: ClassifyRequest<Shape>,
  ): Promise<z.infer<Shape>> {
    const { zodOutputFormat } = await import("@anthropic-ai/sdk/helpers/zod");
    try {
      const message = await this.#client.messages.parse(
        {
          model: request.model,
          max_tokens: 4096,
          system: request.system,
          messages: [{ role: "user", content: request.prompt }],
          output_config: {
            effort: request.effort,
            format: zodOutputFormat(request.schema),
          },
        },
        { signal: request.signal },
      );

      const parsed: unknown = message.parsed_output;
      if (parsed === null || parsed === undefined) {
        throw new TurnFailure("structured_output_missing", "the model returned no parsed output");
      }
      return request.schema.parse(parsed);
    } catch (error) {
      throw describeModelError(error);
    }
  }
}

export function describeModelError(error: unknown): Error {
  if (error instanceof TurnFailure) return error;

  if (error instanceof Anthropic.RateLimitError) {
    return new TurnFailure("model_rate_limited", "the model provider is rate limiting requests", {
      cause: error,
    });
  }
  if (error instanceof Anthropic.APIError) {
    return new TurnFailure(
      "model_api_error",
      `the model provider returned status ${String(error.status)}`,
      { cause: error },
    );
  }
  if (error instanceof Error && error.name === "AbortError") {
    return new TurnFailure("turn_cancelled", "the turn was cancelled", { cause: error });
  }
  return new TurnFailure("model_unavailable", "the model could not be reached", { cause: error });
}
