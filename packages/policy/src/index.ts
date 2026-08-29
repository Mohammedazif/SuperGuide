import type {
  AgentAction,
  IdentityTier,
  PolicyVerdict,
  RiskClass,
} from "@superguide/contract/public";
import { firstMatchingRule } from "./matching.js";
import { isSensitiveText } from "./sensitive.js";

export interface ProcedurePolicy {
  never: readonly string[];
  confirm: readonly string[];
  escalateIf: readonly string[];
}

export interface PolicyIdentity {
  tier: IdentityTier;
  scopes: readonly string[];
}

export interface ProductPolicy {
  blockedRiskClasses: readonly RiskClass[];
  confirmEveryWrite: boolean;
}

export interface PolicyInput {
  action: AgentAction;
  toolName: string;
  compiledToolNames: readonly string[];
  requiredScopes: readonly string[];
  procedure: ProcedurePolicy | null;
  identity: PolicyIdentity;
  productPolicy: ProductPolicy;
  signals: readonly string[];
}

export const DEFAULT_PRODUCT_POLICY: ProductPolicy = {
  blockedRiskClasses: ["destructive", "financial"],
  confirmEveryWrite: true,
};

export function describeAction(action: AgentAction, toolName: string): string {
  switch (action.type) {
    case "call_api":
      return `${action.type} ${toolName} ${action.tool} ${action.risk} ${JSON.stringify(action.arguments)}`;
    case "invoke_capability":
      return `${action.type} ${toolName} ${action.capability} ${action.risk} ${JSON.stringify(action.arguments)}`;
    case "navigate_route":
      return `${action.type} ${toolName} ${action.routeId} ${action.risk} ${JSON.stringify(action.params)}`;
    case "ask_user":
      return `${action.type} ${toolName} ${action.risk} ${action.question}`;
    case "escalate":
      return `${action.type} ${toolName} ${action.risk} ${action.reason}`;
    case "set_value":
    case "select_option":
      return `${action.type} ${toolName} ${action.risk} ${action.ref} ${action.value}`;
    case "set_checked":
      return `${action.type} ${toolName} ${action.risk} ${action.ref} ${String(action.checked)}`;
    case "click":
    case "hover":
      return `${action.type} ${toolName} ${action.risk} ${action.ref}`;
    case "press_key":
      return `${action.type} ${toolName} ${action.risk} ${action.key}`;
    case "scroll":
      return `${action.type} ${toolName} ${action.risk} ${action.direction}`;
    case "wait_for":
      return `${action.type} ${toolName} ${action.risk} ${action.role} ${action.nameContains}`;
    default: {
      const exhaustive: never = action;
      throw new Error(`unhandled action: ${JSON.stringify(exhaustive)}`);
    }
  }
}

export function previewFor(action: AgentAction): string {
  switch (action.type) {
    case "call_api":
      return `${action.intent} This calls ${action.tool} with ${JSON.stringify(action.arguments)}.`;
    case "invoke_capability":
      return `${action.intent} This runs ${action.capability} with ${JSON.stringify(action.arguments)}.`;
    case "navigate_route":
      return `${action.intent} This takes you to ${action.routeId}.`;
    case "set_value":
      return `${action.intent} This sets the field to ${JSON.stringify(action.value)}.`;
    case "select_option":
      return `${action.intent} This chooses ${JSON.stringify(action.value)}.`;
    case "set_checked":
      return `${action.intent} This turns the control ${action.checked ? "on" : "off"}.`;
    case "click":
      return `${action.intent} This clicks one control on the page.`;
    case "press_key":
      return `${action.intent} This presses ${action.key}.`;
    case "hover":
    case "scroll":
    case "wait_for":
      return action.intent;
    case "ask_user":
      return action.question;
    case "escalate":
      return action.summary;
    default: {
      const exhaustive: never = action;
      throw new Error(`unhandled action: ${JSON.stringify(exhaustive)}`);
    }
  }
}

// Pure. No I/O, no clock, no randomness. First matching rule wins; order is the specification.
export function evaluatePolicy(input: PolicyInput): PolicyVerdict {
  const descriptor = describeAction(input.action, input.toolName);

  if (!input.compiledToolNames.includes(input.toolName)) {
    return { decision: "block", reason: "unknown_action" };
  }

  if (input.productPolicy.blockedRiskClasses.includes(input.action.risk)) {
    return { decision: "block", reason: "risk_class_blocked" };
  }

  if (input.procedure !== null) {
    const forbidden = firstMatchingRule(input.procedure.never, [descriptor]);
    if (forbidden !== null) return { decision: "block", reason: "procedure_forbids" };
  }

  if (input.identity.tier !== "verified" && input.action.risk !== "read") {
    // Grounded UI writes can still run after an on-screen approval; API writes cannot.
    if (!isGroundedMutating(input.action)) {
      return { decision: "block", reason: "identity_insufficient" };
    }
  }

  const held = new Set(input.identity.scopes);
  for (const scope of input.requiredScopes) {
    if (!held.has(scope)) return { decision: "block", reason: "scope_missing" };
  }

  if (input.procedure !== null) {
    const escalation = firstMatchingRule(input.procedure.escalateIf, [descriptor, ...input.signals]);
    if (escalation !== null) return { decision: "block", reason: "escalation_condition" };
  }

  if (input.procedure !== null) {
    const confirmation = firstMatchingRule(input.procedure.confirm, [descriptor]);
    if (confirmation !== null) {
      return { decision: "confirm", reason: "procedure_confirm", preview: previewFor(input.action) };
    }
  }

  if (
    input.action.risk !== "read" &&
    (isSensitiveText(descriptor) || isSensitiveText(input.action.intent))
  ) {
    return {
      decision: "confirm",
      reason: "write_requires_confirmation",
      preview: previewFor(input.action),
    };
  }

  if (input.action.risk !== "read" && input.productPolicy.confirmEveryWrite) {
    return {
      decision: "confirm",
      reason: "write_requires_confirmation",
      preview: previewFor(input.action),
    };
  }

  return { decision: "allow" };
}

function isGroundedMutating(action: AgentAction): boolean {
  return (
    action.type === "click" ||
    action.type === "set_value" ||
    action.type === "select_option" ||
    action.type === "set_checked" ||
    action.type === "press_key"
  );
}

export { ruleMatches, tokenise, firstMatchingRule } from "./matching.js";
export { SENSITIVE_TERMS, isSensitiveText } from "./sensitive.js";
export {
  evaluateAnywherePolicy,
  describeActionForConfirmation,
} from "./anywhere.js";
