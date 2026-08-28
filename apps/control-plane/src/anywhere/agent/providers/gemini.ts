import type Anthropic from "@anthropic-ai/sdk";
import type { BetaMessageStreamParams } from "@anthropic-ai/sdk/resources/beta/messages";
import { GoogleGenAI } from "@google/genai";
import type {
  Content,
  FunctionDeclaration,
  GenerateContentParameters,
  GenerateContentResponse,
  Part,
} from "@google/genai";
import {
  CLASSIFIER_SYSTEM,
  classifierUserContent,
  INJECTION_SCAN_JSON_SCHEMA,
  injectionScanSchema,
  NO_VERDICT,
  type InjectionScan,
} from "../classifier.js";
import type { ModelProvider } from "../provider.js";

export const GEMINI_PLANNER_MODEL = "gemini-2.5-pro";
export const GEMINI_CLASSIFIER_MODEL = "gemini-2.5-flash";

type BetaMessage = Anthropic.Beta.Messages.BetaMessage;
type ContentBlock = Anthropic.Beta.Messages.BetaContentBlock;

// Refusal-shaped finish reasons; anything here ends the turn as a model refusal.
const REFUSAL_FINISH = new Set([
  "SAFETY",
  "RECITATION",
  "BLOCKLIST",
  "PROHIBITED_CONTENT",
  "SPII",
  "IMAGE_SAFETY",
]);

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

export function toGeminiRequest(request: BetaMessageStreamParams): GenerateContentParameters {
  const contents: Content[] = [];
  const namesByCallId = new Map<string, string>();
  for (const message of request.messages) {
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
  const functionDeclarations: FunctionDeclaration[] = (request.tools ?? []).flatMap((tool) =>
    "input_schema" in tool
      ? [
          {
            name: tool.name,
            ...(tool.description === undefined ? {} : { description: tool.description }),
            parametersJsonSchema: tool.input_schema,
          },
        ]
      : [],
  );
  return {
    model: GEMINI_PLANNER_MODEL,
    contents,
    config: {
      systemInstruction: systemText(request.system),
      tools: [{ functionDeclarations }],
      maxOutputTokens: request.max_tokens,
    },
  };
}

export function fromGeminiResponse(response: GenerateContentResponse): BetaMessage {
  const candidate = response.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];
  const content: ContentBlock[] = [];
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
  let stopReason: BetaMessage["stop_reason"];
  if (refused) stopReason = "refusal";
  else if (finish === "MAX_TOKENS") stopReason = "max_tokens";
  else if (hasToolUse) stopReason = "tool_use";
  else stopReason = "end_turn";
  const usage = response.usageMetadata;
  return {
    id: response.responseId ?? `gemini_${crypto.randomUUID()}`,
    type: "message",
    role: "assistant",
    model: response.modelVersion ?? GEMINI_PLANNER_MODEL,
    container: null,
    context_management: null,
    diagnostics: null,
    content,
    stop_reason: stopReason,
    stop_details: refused
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
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: usage?.cachedContentTokenCount ?? 0,
      fallback_credit: null,
      inference_geo: null,
      input_tokens: usage?.promptTokenCount ?? 0,
      iterations: null,
      output_tokens: (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0),
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: null,
      speed: null,
    },
  };
}

async function scanWithGemini(client: GoogleGenAI, strings: string[]): Promise<InjectionScan> {
  if (strings.length === 0) return { suspicious: false, findings: [] };
  const response = await client.models.generateContent({
    model: GEMINI_CLASSIFIER_MODEL,
    contents: [{ role: "user", parts: [{ text: classifierUserContent(strings) }] }],
    config: {
      systemInstruction: CLASSIFIER_SYSTEM,
      responseMimeType: "application/json",
      responseJsonSchema: INJECTION_SCAN_JSON_SCHEMA,
      maxOutputTokens: 1024,
      thinkingConfig: { thinkingBudget: 0 },
    },
  });
  let candidate: unknown;
  try {
    candidate = JSON.parse(response.text ?? "");
  } catch {
    return NO_VERDICT;
  }
  const parsed = injectionScanSchema.safeParse(candidate);
  return parsed.success ? parsed.data : NO_VERDICT;
}

export function makeGeminiProvider(apiKey: string): ModelProvider {
  const client = new GoogleGenAI({ apiKey });
  return {
    plan: async (request) => fromGeminiResponse(await client.models.generateContent(toGeminiRequest(request))),
    scan: (strings) => scanWithGemini(client, strings),
  };
}
