import type Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type {
  Response,
  ResponseInputItem,
  ResponseReasoningItem,
  Tool,
} from "openai/resources/responses/responses";
import type { ResponseStreamParams } from "openai/lib/responses/ResponseStream";
import { z } from "zod";
import { TurnFailure } from "../errors.js";
import { CLASSIFICATION_MODEL, type EffortLevel } from "./routing.js";
import {
  MAX_OUTPUT_TOKENS,
  type ClassifyRequest,
  type GenerateRequest,
  type GenerateResult,
  type ModelClient,
  type ModelUsage,
} from "./client.js";

export const OPENAI_PLANNING_MODEL = "gpt-5.5";
export const OPENAI_CLASSIFICATION_MODEL = "gpt-5.4-mini";

// The routing table's model ids name roles, not vendors: the classification id
// selects this provider's classifier, anything else its planner.
function modelFor(routed: string): string {
  return routed === CLASSIFICATION_MODEL ? OPENAI_CLASSIFICATION_MODEL : OPENAI_PLANNING_MODEL;
}

// "max" is not offered on every reasoning model; "xhigh" is the highest tier
// that is safe to request across the family.
function reasoningEffortOf(effort: EffortLevel): "low" | "medium" | "high" | "xhigh" {
  return effort === "max" ? "xhigh" : effort;
}

function systemText(system: Anthropic.TextBlockParam[] | string): string {
  return typeof system === "string" ? system : system.map((block) => block.text).join("\n");
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part: unknown) => {
        const block = part as { type?: string; text?: string };
        return block.type === "text" ? (block.text ?? "") : "";
      })
      .join("");
  }
  return "";
}

// Reasoning items must travel back verbatim (the API rejects a function_call
// whose paired reasoning item is missing when nothing is stored server-side),
// so each one rides the turn history inside a thinking block's signature.
function stashReasoning(item: ResponseReasoningItem): Anthropic.ThinkingBlock {
  return {
    type: "thinking",
    thinking: item.summary.map((entry) => entry.text).join("\n"),
    signature: JSON.stringify({
      type: "reasoning",
      id: item.id,
      summary: item.summary,
      ...(item.content === undefined ? {} : { content: item.content }),
      ...(item.encrypted_content == null ? {} : { encrypted_content: item.encrypted_content }),
    }),
  };
}

function unstashReasoning(signature: string): ResponseReasoningItem | null {
  try {
    const parsed = JSON.parse(signature) as { type?: unknown; id?: unknown; summary?: unknown };
    if (parsed.type !== "reasoning") return null;
    if (typeof parsed.id !== "string" || !Array.isArray(parsed.summary)) return null;
    return parsed as unknown as ResponseReasoningItem;
  } catch {
    return null;
  }
}

export function toOpenAIInput(messages: Anthropic.MessageParam[]): ResponseInputItem[] {
  const input: ResponseInputItem[] = [];
  for (const message of messages) {
    if (typeof message.content === "string") {
      input.push({ type: "message", role: message.role, content: message.content });
      continue;
    }
    for (const block of message.content) {
      if (block.type === "text") {
        input.push({ type: "message", role: message.role, content: block.text });
      } else if (block.type === "tool_use") {
        input.push({
          type: "function_call",
          call_id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input),
        });
      } else if (block.type === "tool_result") {
        const text = toolResultText(block.content);
        input.push({
          type: "function_call_output",
          call_id: block.tool_use_id,
          output: block.is_error === true ? `[tool error] ${text}` : text,
        });
      } else if (block.type === "thinking") {
        const item = unstashReasoning(block.signature);
        if (item !== null) input.push(item);
      }
    }
  }
  return input;
}

// Compiled tool schemas may leave parameters optional, which strict mode
// forbids; the loop already validates every tool call against the contract, so
// schema following stays best-effort here rather than reshaping the schemas.
export function toOpenAITools(tools: Anthropic.Tool[]): Tool[] {
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description ?? null,
    parameters: tool.input_schema,
    strict: false,
  }));
}

function parsedArguments(raw: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function fromOpenAIResponse(response: Response): Anthropic.Message {
  const content: Anthropic.ContentBlock[] = [];
  const refusal = { seen: false };
  for (const item of response.output) {
    if (item.type === "reasoning") {
      content.push(stashReasoning(item));
    } else if (item.type === "message") {
      for (const part of item.content) {
        if (part.type === "output_text") {
          if (part.text.length > 0) {
            content.push({ type: "text", text: part.text, citations: null });
          }
        } else {
          refusal.seen = true;
        }
      }
    } else if (item.type === "function_call") {
      content.push({
        type: "tool_use",
        id: item.call_id,
        name: item.name,
        input: parsedArguments(item.arguments),
        caller: { type: "direct" },
      });
    }
  }
  const truncated =
    response.status === "incomplete" &&
    response.incomplete_details?.reason === "max_output_tokens";
  const hasToolUse = content.some((block) => block.type === "tool_use");
  let stopReason: Anthropic.Message["stop_reason"];
  if (refusal.seen) stopReason = "refusal";
  else if (truncated) stopReason = "max_tokens";
  else if (hasToolUse) stopReason = "tool_use";
  else stopReason = "end_turn";
  return {
    id: response.id,
    type: "message",
    role: "assistant",
    model: response.model,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    stop_details: null,
    usage: {
      input_tokens: response.usage?.input_tokens ?? 0,
      output_tokens: response.usage?.output_tokens ?? 0,
      cache_read_input_tokens: response.usage?.input_tokens_details.cached_tokens ?? 0,
      cache_creation_input_tokens: response.usage?.input_tokens_details.cache_write_tokens ?? 0,
      cache_creation: null,
      server_tool_use: null,
      service_tier: null,
      inference_geo: null,
      output_tokens_details: null,
    },
    container: null,
  };
}

function usageOf(message: Anthropic.Message): ModelUsage {
  return {
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
    cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
    cacheCreationTokens: message.usage.cache_creation_input_tokens ?? 0,
  };
}

function describeOpenAIError(error: unknown): Error {
  if (error instanceof TurnFailure) return error;
  if (error instanceof OpenAI.RateLimitError) {
    return new TurnFailure("model_rate_limited", "the model provider is rate limiting requests", {
      cause: error,
    });
  }
  if (error instanceof OpenAI.APIUserAbortError) {
    return new TurnFailure("turn_cancelled", "the turn was cancelled", { cause: error });
  }
  if (error instanceof OpenAI.APIError) {
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

export interface OpenAIModelClientOptions {
  apiKey: string;
  now?: () => number;
}

export class OpenAIModelClient implements ModelClient {
  readonly #client: OpenAI;
  readonly #now: () => number;

  constructor(options: OpenAIModelClientOptions) {
    this.#client = new OpenAI({ apiKey: options.apiKey });
    this.#now = options.now ?? (() => Date.now());
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    const startedAt = this.#now();
    const params: ResponseStreamParams = {
      model: modelFor(request.model),
      instructions: systemText(request.system),
      input: toOpenAIInput(request.messages),
      tools: toOpenAITools(request.tools),
      tool_choice: "auto",
      parallel_tool_calls: false,
      reasoning: { effort: reasoningEffortOf(request.effort) },
      max_output_tokens: MAX_OUTPUT_TOKENS,
      store: false,
      include: ["reasoning.encrypted_content"],
    };
    try {
      const stream = this.#client.responses.stream(params, { signal: request.signal });
      stream.on("response.output_text.delta", (event) => {
        request.onTextDelta?.(event.delta);
      });
      const response = await stream.finalResponse();
      const message = fromOpenAIResponse(response);
      return { message, usage: usageOf(message), latencyMs: this.#now() - startedAt };
    } catch (error) {
      throw describeOpenAIError(error);
    }
  }

  async classify<Shape extends z.ZodType>(
    request: ClassifyRequest<Shape>,
  ): Promise<z.infer<Shape>> {
    let response: Response;
    try {
      response = await this.#client.responses.create(
        {
          model: modelFor(request.model),
          instructions: request.system,
          input: request.prompt,
          reasoning: { effort: reasoningEffortOf(request.effort) },
          max_output_tokens: 4096,
          store: false,
          text: {
            format: {
              type: "json_schema",
              name: "classification",
              schema: z.toJSONSchema(request.schema),
              strict: false,
            },
          },
        },
        { signal: request.signal },
      );
    } catch (error) {
      throw describeOpenAIError(error);
    }
    let candidate: unknown;
    try {
      candidate = JSON.parse(response.output_text);
    } catch {
      throw new TurnFailure("structured_output_missing", "the model returned no parsed output");
    }
    const parsed = request.schema.safeParse(candidate);
    if (!parsed.success) {
      throw new TurnFailure(
        "structured_output_missing",
        "the model's output did not match the expected shape",
      );
    }
    return parsed.data;
  }
}
