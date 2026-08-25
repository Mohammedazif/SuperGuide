import type Anthropic from "@anthropic-ai/sdk";
import { ApiError, GoogleGenAI } from "@google/genai";
import type {
  Content,
  FunctionDeclaration,
  GenerateContentParameters,
  GenerateContentResponse,
  Part,
} from "@google/genai";
import { z } from "zod";
import { TurnFailure } from "../errors.js";
import { CLASSIFICATION_MODEL } from "./routing.js";
import {
  MAX_OUTPUT_TOKENS,
  type ClassifyRequest,
  type GenerateRequest,
  type GenerateResult,
  type ModelClient,
  type ModelUsage,
} from "./client.js";

export const GEMINI_PLANNING_MODEL = "gemini-2.5-pro";
export const GEMINI_CLASSIFICATION_MODEL = "gemini-2.5-flash";

// The routing table's model ids name roles, not vendors: the classification id
// selects this provider's classifier, anything else its planner. Effort levels
// have no analog on this family, so thinking stays at the model's own default.
function modelFor(routed: string): string {
  return routed === CLASSIFICATION_MODEL ? GEMINI_CLASSIFICATION_MODEL : GEMINI_PLANNING_MODEL;
}

// Refusal-shaped finish reasons; anything here ends the turn without a usable message.
const REFUSAL_FINISH = new Set([
  "SAFETY",
  "RECITATION",
  "BLOCKLIST",
  "PROHIBITED_CONTENT",
  "SPII",
  "IMAGE_SAFETY",
]);

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

// Thought signatures must return with the part they were issued for, or the
// model loses its reasoning thread across function calls. Each one rides the
// turn history inside a thinking block and is re-attached to the next part.
function encodeSignature(thoughtSignature: string | undefined): string {
  return thoughtSignature === undefined ? "{}" : JSON.stringify({ sig: thoughtSignature });
}

function decodeSignature(signature: string): string | null {
  try {
    const parsed = JSON.parse(signature) as { sig?: unknown };
    return typeof parsed.sig === "string" ? parsed.sig : null;
  } catch {
    return null;
  }
}

// A Gemini-issued call id must echo back verbatim while a synthetic one (made
// only to satisfy the internal shape's binding) must not reach the API.
function callIdFor(geminiId: string | undefined): string {
  return geminiId === undefined ? `s-${crypto.randomUUID()}` : `g-${geminiId}`;
}

function geminiIdOf(callId: string): string | null {
  return callId.startsWith("g-") ? callId.slice(2) : null;
}

export function toGeminiContents(messages: Anthropic.MessageParam[]): Content[] {
  const contents: Content[] = [];
  const namesByCallId = new Map<string, string>();
  for (const message of messages) {
    const parts: Part[] = [];
    if (typeof message.content === "string") {
      parts.push({ text: message.content });
    } else {
      const pending = { signature: null as string | null };
      const attach = (part: Part): Part => {
        if (pending.signature === null) return part;
        const signed = { ...part, thoughtSignature: pending.signature };
        pending.signature = null;
        return signed;
      };
      for (const block of message.content) {
        if (block.type === "thinking") {
          pending.signature = decodeSignature(block.signature);
        } else if (block.type === "text") {
          parts.push(attach({ text: block.text }));
        } else if (block.type === "tool_use") {
          namesByCallId.set(block.id, block.name);
          const geminiId = geminiIdOf(block.id);
          parts.push(
            attach({
              functionCall: {
                ...(geminiId === null ? {} : { id: geminiId }),
                name: block.name,
                args: block.input as Record<string, unknown>,
              },
            }),
          );
        } else if (block.type === "tool_result") {
          const geminiId = geminiIdOf(block.tool_use_id);
          parts.push({
            functionResponse: {
              ...(geminiId === null ? {} : { id: geminiId }),
              name: namesByCallId.get(block.tool_use_id) ?? "unknown",
              response: {
                output: toolResultText(block.content),
                ...(block.is_error === true ? { error: true } : {}),
              },
            },
          });
        }
      }
    }
    contents.push({ role: message.role === "assistant" ? "model" : "user", parts });
  }
  return contents;
}

export function toGeminiRequest(request: GenerateRequest): GenerateContentParameters {
  const functionDeclarations: FunctionDeclaration[] = request.tools.map((tool) => ({
    name: tool.name,
    ...(tool.description === undefined ? {} : { description: tool.description }),
    parametersJsonSchema: tool.input_schema,
  }));
  return {
    model: modelFor(request.model),
    contents: toGeminiContents(request.messages),
    config: {
      systemInstruction: systemText(request.system),
      tools: [{ functionDeclarations }],
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      abortSignal: request.signal,
    },
  };
}

export function fromGeminiResponse(response: GenerateContentResponse): Anthropic.Message {
  const candidate = response.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];
  const content: Anthropic.ContentBlock[] = [];
  for (const part of parts) {
    if (part.thought === true) {
      content.push({
        type: "thinking",
        thinking: part.text ?? "",
        signature: encodeSignature(part.thoughtSignature),
      });
      continue;
    }
    if (part.thoughtSignature !== undefined) {
      content.push({ type: "thinking", thinking: "", signature: encodeSignature(part.thoughtSignature) });
    }
    if (part.functionCall !== undefined) {
      content.push({
        type: "tool_use",
        id: callIdFor(part.functionCall.id),
        name: part.functionCall.name ?? "",
        input: part.functionCall.args ?? {},
        caller: { type: "direct" },
      });
    } else if (part.text !== undefined && part.text.length > 0) {
      content.push({ type: "text", text: part.text, citations: null });
    }
  }
  const finish: string | null = candidate?.finishReason ?? null;
  const refused = candidate === undefined || (finish !== null && REFUSAL_FINISH.has(finish));
  const hasToolUse = content.some((block) => block.type === "tool_use");
  let stopReason: Anthropic.Message["stop_reason"];
  if (refused) stopReason = "refusal";
  else if (finish === "MAX_TOKENS") stopReason = "max_tokens";
  else if (hasToolUse) stopReason = "tool_use";
  else stopReason = "end_turn";
  const usage = response.usageMetadata;
  return {
    id: response.responseId ?? `gemini_${crypto.randomUUID()}`,
    type: "message",
    role: "assistant",
    model: response.modelVersion ?? GEMINI_PLANNING_MODEL,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    stop_details: null,
    usage: {
      input_tokens: usage?.promptTokenCount ?? 0,
      output_tokens: (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0),
      cache_read_input_tokens: usage?.cachedContentTokenCount ?? 0,
      cache_creation_input_tokens: 0,
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

function describeGeminiError(error: unknown): Error {
  if (error instanceof TurnFailure) return error;
  if (error instanceof ApiError) {
    if (error.status === 429) {
      return new TurnFailure("model_rate_limited", "the model provider is rate limiting requests", {
        cause: error,
      });
    }
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

export interface GeminiModelClientOptions {
  apiKey: string;
  now?: () => number;
}

export class GeminiModelClient implements ModelClient {
  readonly #client: GoogleGenAI;
  readonly #now: () => number;

  constructor(options: GeminiModelClientOptions) {
    this.#client = new GoogleGenAI({ apiKey: options.apiKey });
    this.#now = options.now ?? (() => Date.now());
  }

  // Text reaches the caller in one delta when the response completes; the
  // streaming variant can replace this without touching the interface.
  async generate(request: GenerateRequest): Promise<GenerateResult> {
    const startedAt = this.#now();
    try {
      const response = await this.#client.models.generateContent(toGeminiRequest(request));
      const message = fromGeminiResponse(response);
      const text = message.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("");
      if (text.length > 0) request.onTextDelta?.(text);
      return { message, usage: usageOf(message), latencyMs: this.#now() - startedAt };
    } catch (error) {
      throw describeGeminiError(error);
    }
  }

  async classify<Shape extends z.ZodType>(
    request: ClassifyRequest<Shape>,
  ): Promise<z.infer<Shape>> {
    let response: GenerateContentResponse;
    try {
      response = await this.#client.models.generateContent({
        model: modelFor(request.model),
        contents: [{ role: "user", parts: [{ text: request.prompt }] }],
        config: {
          systemInstruction: request.system,
          responseMimeType: "application/json",
          responseJsonSchema: z.toJSONSchema(request.schema),
          maxOutputTokens: 4096,
          abortSignal: request.signal,
        },
      });
    } catch (error) {
      throw describeGeminiError(error);
    }
    let candidate: unknown;
    try {
      candidate = JSON.parse(response.text ?? "");
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
