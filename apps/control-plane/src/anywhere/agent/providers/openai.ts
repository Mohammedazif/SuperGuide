import type Anthropic from "@anthropic-ai/sdk";
import type { BetaMessageStreamParams } from "@anthropic-ai/sdk/resources/beta/messages";
import OpenAI from "openai";
import type {
  Response,
  ResponseCreateParamsNonStreaming,
  ResponseInputItem,
  ResponseReasoningItem,
  Tool,
} from "openai/resources/responses/responses";
import {
  CLASSIFIER_SYSTEM,
  classifierUserContent,
  INJECTION_SCAN_JSON_SCHEMA,
  injectionScanSchema,
  NO_VERDICT,
  type InjectionScan,
} from "../classifier.js";
import type { ModelProvider } from "../provider.js";

export const OPENAI_PLANNER_MODEL = "gpt-5.5";
export const OPENAI_CLASSIFIER_MODEL = "gpt-5.4-mini";

type BetaMessage = Anthropic.Beta.Messages.BetaMessage;
type ContentBlock = Anthropic.Beta.Messages.BetaContentBlock;

function systemText(system: BetaMessageStreamParams["system"]): string {
  if (system === undefined) return "";
  if (typeof system === "string") return system;
  return system.map((block) => block.text).join("\n");
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
function stashReasoning(item: ResponseReasoningItem): ContentBlock {
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

export function toOpenAIRequest(
  request: BetaMessageStreamParams,
): ResponseCreateParamsNonStreaming {
  const input: ResponseInputItem[] = [];
  for (const message of request.messages) {
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
  const tools: Tool[] = (request.tools ?? []).flatMap((tool): Tool[] =>
    "input_schema" in tool
      ? [
          {
            type: "function",
            name: tool.name,
            description: tool.description ?? null,
            parameters: tool.input_schema as unknown as Record<string, unknown>,
            strict: true,
          },
        ]
      : [],
  );
  return {
    model: OPENAI_PLANNER_MODEL,
    instructions: systemText(request.system),
    input,
    tools,
    tool_choice: "auto",
    parallel_tool_calls: false,
    reasoning: { effort: "high" },
    max_output_tokens: request.max_tokens,
    store: false,
    include: ["reasoning.encrypted_content"],
  };
}

function parsedArguments(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export function fromOpenAIResponse(response: Response): BetaMessage {
  const content: ContentBlock[] = [];
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
  let stopReason: BetaMessage["stop_reason"];
  if (refusal.seen) stopReason = "refusal";
  else if (truncated) stopReason = "max_tokens";
  else if (hasToolUse) stopReason = "tool_use";
  else stopReason = "end_turn";
  return {
    id: response.id,
    type: "message",
    role: "assistant",
    model: response.model,
    container: null,
    context_management: null,
    diagnostics: null,
    content,
    stop_reason: stopReason,
    stop_details: refusal.seen
      ? {
          type: "refusal",
          category: null,
          explanation: null,
          fallback_credit_token: null,
          fallback_has_prefill_claim: null,
          recommended_model: null,
        }
      : null,
    stop_sequence: null,
    usage: {
      cache_creation: null,
      cache_creation_input_tokens: response.usage?.input_tokens_details.cache_write_tokens ?? 0,
      cache_read_input_tokens: response.usage?.input_tokens_details.cached_tokens ?? 0,
      fallback_credit: null,
      inference_geo: null,
      input_tokens: response.usage?.input_tokens ?? 0,
      iterations: null,
      output_tokens: response.usage?.output_tokens ?? 0,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: null,
      speed: null,
    },
  };
}

async function scanWithOpenAI(client: OpenAI, strings: string[]): Promise<InjectionScan> {
  if (strings.length === 0) return { suspicious: false, findings: [] };
  const response = await client.responses.create({
    model: OPENAI_CLASSIFIER_MODEL,
    instructions: CLASSIFIER_SYSTEM,
    input: classifierUserContent(strings),
    reasoning: { effort: "low" },
    max_output_tokens: 2048,
    store: false,
    text: {
      format: {
        type: "json_schema",
        name: "injection_scan",
        schema: INJECTION_SCAN_JSON_SCHEMA as unknown as Record<string, unknown>,
        strict: true,
      },
    },
  });
  let candidate: unknown;
  try {
    candidate = JSON.parse(response.output_text);
  } catch {
    return NO_VERDICT;
  }
  const parsed = injectionScanSchema.safeParse(candidate);
  return parsed.success ? parsed.data : NO_VERDICT;
}

export function makeOpenAIProvider(apiKey: string): ModelProvider {
  const client = new OpenAI({ apiKey });
  return {
    plan: async (request) => fromOpenAIResponse(await client.responses.create(toOpenAIRequest(request))),
    scan: (strings) => scanWithOpenAI(client, strings),
  };
}
