import type Anthropic from "@anthropic-ai/sdk";
import { agentActionSchema, type AgentAction, type Identity } from "@superguide/contract/public";
import type { CompiledTool } from "../tools/compiled.js";
import { resolveExpectTemplate } from "../expect/template.js";
import type { CachedPrefix } from "../model/prompt.js";
import type { ModelChoice } from "../model/routing.js";
import type { ModelClient, ModelUsage } from "../model/client.js";
import { TurnFailure } from "../errors.js";

export type PlanOutcome =
  | { kind: "action"; action: AgentAction; tool: CompiledTool }
  | { kind: "complete"; summary: string; resolutionState: "resolved" | "unresolved" }
  | { kind: "no_action"; text: string };

export interface PlanResult {
  outcome: PlanOutcome;
  assistantTurn: Anthropic.MessageParam;
  toolUseId: string | null;
  usage: ModelUsage;
  latencyMs: number;
  model: string;
  text: string;
}

export interface PlanRequest {
  client: ModelClient;
  prefix: CachedPrefix;
  messages: Anthropic.MessageParam[];
  choice: ModelChoice;
  toolsByName: ReadonlyMap<string, CompiledTool>;
  identity: Identity;
  signal: AbortSignal;
  onTextDelta: (text: string) => void;
}

function stringRecord(value: Record<string, unknown>): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined || entry === null) continue;
    output[key] = typeof entry === "string" ? entry : JSON.stringify(entry);
  }
  return output;
}

export function buildAction(
  tool: CompiledTool,
  toolUseId: string,
  input: Record<string, unknown>,
  identity: Identity,
): { ok: true; action: AgentAction } | { ok: false; reason: string } {
  const { intent: rawIntent, ...rest } = input;
  const intent = typeof rawIntent === "string" && rawIntent.length > 0 ? rawIntent : tool.description;

  const expect = resolveExpectTemplate(tool.expectTemplate, {
    params: rest,
    identity: { ...identity.claims, endUserId: identity.endUserId, externalId: identity.externalId },
  });

  const envelope = {
    toolCallId: toolUseId,
    intent,
    expect,
    risk: tool.risk,
    timeoutMs: tool.timeoutMs,
  };

  const source = tool.source;
  let candidate: unknown;

  switch (source.kind) {
    case "api":
      candidate = { ...envelope, type: "call_api", tool: tool.name, arguments: rest };
      break;
    case "capability":
      candidate = {
        ...envelope,
        type: "invoke_capability",
        capability: source.capability,
        arguments: rest,
      };
      break;
    case "route":
      candidate = {
        ...envelope,
        type: "navigate_route",
        routeId: source.routeId,
        params: stringRecord(rest),
      };
      break;
    case "grounded":
      candidate = { ...envelope, type: source.actionType, ...rest };
      break;
    case "ask_user":
      candidate = { ...envelope, type: "ask_user", ...rest };
      break;
    case "escalate":
      candidate = { ...envelope, type: "escalate", ...rest };
      break;
    case "finish":
      return { ok: false, reason: "finish is a completion, not an action" };
    default: {
      const exhaustive: never = source;
      throw new Error(`unhandled tool source: ${JSON.stringify(exhaustive)}`);
    }
  }

  const parsed = agentActionSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      reason: parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; "),
    };
  }
  return { ok: true, action: parsed.data };
}

function textOf(message: Anthropic.Message): string {
  return message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
}

export async function plan(request: PlanRequest): Promise<PlanResult> {
  const generated = await request.client.generate({
    model: request.choice.model,
    effort: request.choice.effort,
    system: request.prefix.system,
    tools: request.prefix.tools,
    messages: request.messages,
    signal: request.signal,
    onTextDelta: request.onTextDelta,
  });

  const message = generated.message;
  const assistantTurn: Anthropic.MessageParam = { role: "assistant", content: message.content };
  const text = textOf(message);

  const toolUse = message.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
  );

  const base = {
    assistantTurn,
    usage: generated.usage,
    latencyMs: generated.latencyMs,
    model: request.choice.model,
    text,
  };

  if (toolUse === undefined) {
    return { ...base, outcome: { kind: "no_action", text }, toolUseId: null };
  }

  const tool = request.toolsByName.get(toolUse.name);
  if (tool === undefined) {
    throw new TurnFailure(
      "unknown_tool",
      `the model called ${toolUse.name}, which is not in the compiled vocabulary`,
    );
  }

  const input = (toolUse.input ?? {}) as Record<string, unknown>;

  if (tool.source.kind === "finish") {
    const summary = typeof input["summary"] === "string" ? input["summary"] : text;
    const resolutionState = input["resolutionState"] === "unresolved" ? "unresolved" : "resolved";
    return {
      ...base,
      outcome: { kind: "complete", summary, resolutionState },
      toolUseId: toolUse.id,
    };
  }

  const built = buildAction(tool, toolUse.id, input, request.identity);
  if (!built.ok) {
    throw new TurnFailure(
      "malformed_action",
      `the model's call to ${toolUse.name} did not form a valid action: ${built.reason}`,
    );
  }

  return {
    ...base,
    outcome: { kind: "action", action: built.action, tool },
    toolUseId: toolUse.id,
  };
}
