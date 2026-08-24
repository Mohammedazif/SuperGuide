import { z } from "zod";
import { expectPredicateSchema } from "./expect.js";
import { type LadderLevel, riskClassSchema } from "./primitives.js";

export const refSchema = z.string().regex(/^e[0-9]+$/);

const envelope = {
  toolCallId: z.string().min(1).max(128),
  intent: z.string().min(1).max(400),
  expect: z.array(expectPredicateSchema).min(1),
  risk: riskClassSchema,
  timeoutMs: z.int().positive().max(120_000),
};

export const EXECUTOR_ACTION_TYPES = [
  "click",
  "set_value",
  "select_option",
  "set_checked",
  "press_key",
  "scroll",
  "hover",
  "wait_for",
  "navigate_route",
  "invoke_capability",
] as const;

export const CONTROL_ACTION_TYPES = ["call_api", "ask_user", "escalate"] as const;

const clickAction = z.object({ type: z.literal("click"), ref: refSchema, ...envelope });
const setValueAction = z.object({
  type: z.literal("set_value"),
  ref: refSchema,
  value: z.string(),
  ...envelope,
});
const selectOptionAction = z.object({
  type: z.literal("select_option"),
  ref: refSchema,
  value: z.string(),
  ...envelope,
});
const setCheckedAction = z.object({
  type: z.literal("set_checked"),
  ref: refSchema,
  checked: z.boolean(),
  ...envelope,
});
const pressKeyAction = z.object({
  type: z.literal("press_key"),
  ref: refSchema.optional(),
  key: z.string().min(1),
  ...envelope,
});
const scrollAction = z.object({
  type: z.literal("scroll"),
  ref: refSchema.optional(),
  direction: z.enum(["up", "down"]),
  amount: z.int().positive().optional(),
  ...envelope,
});
const hoverAction = z.object({ type: z.literal("hover"), ref: refSchema, ...envelope });
const waitForAction = z.object({
  type: z.literal("wait_for"),
  role: z.string().min(1),
  nameContains: z.string().min(1),
  ...envelope,
});
const navigateRouteAction = z.object({
  type: z.literal("navigate_route"),
  routeId: z.string().min(1),
  params: z.record(z.string(), z.string()),
  ...envelope,
});
const invokeCapabilityAction = z.object({
  type: z.literal("invoke_capability"),
  capability: z.string().regex(/^[a-z][a-z0-9_]*$/),
  arguments: z.record(z.string(), z.unknown()),
  ...envelope,
});
const callApiAction = z.object({
  type: z.literal("call_api"),
  tool: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()),
  ...envelope,
});
const askUserAction = z.object({
  type: z.literal("ask_user"),
  question: z.string().min(1).max(500),
  choices: z.array(z.string()).max(6).optional(),
  ...envelope,
});
const escalateAction = z.object({
  type: z.literal("escalate"),
  reason: z.string().min(1),
  summary: z.string().min(1),
  ...envelope,
});

export const executorActionSchema = z.discriminatedUnion("type", [
  clickAction,
  setValueAction,
  selectOptionAction,
  setCheckedAction,
  pressKeyAction,
  scrollAction,
  hoverAction,
  waitForAction,
  navigateRouteAction,
  invokeCapabilityAction,
]);
export type ExecutorAction = z.infer<typeof executorActionSchema>;
export type ExecutorActionType = ExecutorAction["type"];

export const agentActionSchema = z.discriminatedUnion("type", [
  clickAction,
  setValueAction,
  selectOptionAction,
  setCheckedAction,
  pressKeyAction,
  scrollAction,
  hoverAction,
  waitForAction,
  navigateRouteAction,
  invokeCapabilityAction,
  callApiAction,
  askUserAction,
  escalateAction,
]);
export type AgentAction = z.infer<typeof agentActionSchema>;
export type AgentActionType = AgentAction["type"];

export const AGENT_ACTION_TYPES: readonly AgentActionType[] = [
  ...EXECUTOR_ACTION_TYPES,
  ...CONTROL_ACTION_TYPES,
];

export function isExecutorActionType(type: string): type is ExecutorActionType {
  return (EXECUTOR_ACTION_TYPES as readonly string[]).includes(type);
}

export function ladderLevelForActionType(type: AgentActionType): LadderLevel {
  switch (type) {
    case "call_api":
      return "L1";
    case "invoke_capability":
      return "L2";
    case "navigate_route":
      return "L3";
    case "click":
    case "set_value":
    case "select_option":
    case "set_checked":
    case "press_key":
    case "scroll":
    case "hover":
    case "wait_for":
      return "L4";
    case "ask_user":
      return "L5";
    case "escalate":
      return "L6";
    default: {
      const exhaustive: never = type;
      throw new Error(`unhandled action type: ${String(exhaustive)}`);
    }
  }
}

export const proposalSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("action"), action: agentActionSchema }),
  z.object({
    kind: z.literal("complete"),
    summary: z.string().min(1),
    resolutionState: z.enum(["resolved", "unresolved"]),
  }),
]);
export type Proposal = z.infer<typeof proposalSchema>;
