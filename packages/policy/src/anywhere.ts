import {
  isPermittedUnderObserve,
  type AgentAction,
  type PolicyInput,
  type Verdict,
} from "@superguide/contract/anywhere";

export function describeActionForConfirmation(
  action: AgentAction,
  adapterMatched: boolean,
): string {
  const provenance = adapterMatched
    ? ""
    : " (working from what the agent can see, not a reviewed capability)";
  switch (action.kind) {
    case "click":
      return `Click the element ${action.target.id}${provenance}`;
    case "type":
      return `Type into ${action.target.id}${provenance}`;
    case "select":
      return `Select "${action.optionLabel}" in ${action.target.id}${provenance}`;
    case "check":
      return `${action.checked ? "Check" : "Uncheck"} ${action.target.id}${provenance}`;
    case "focus":
      return `Focus ${action.target.id}${provenance}`;
    case "scrollIntoView":
      return `Scroll ${action.target.id} into view${provenance}`;
    case "navigate":
      return `Go to ${action.path}${provenance}`;
    case "waitFor":
      return `Wait for the page to settle${provenance}`;
    case "readBack":
      return `Read ${action.target.id} back${provenance}`;
    default: {
      const exhausted: never = action;
      throw new Error(`unreachable action ${JSON.stringify(exhausted)}`);
    }
  }
}

export function evaluateAnywherePolicy(input: PolicyInput): Verdict {
  if (!input.siteActivated) {
    return { kind: "refuse", reason: "site_not_activated" };
  }

  const stateChanging = !isPermittedUnderObserve(input.action.kind);
  if (input.tier === "observe" && stateChanging) {
    return { kind: "refuse", reason: "grant_insufficient" };
  }

  if (input.risk === "read") {
    return { kind: "proceed" };
  }

  if (input.risk === "write" && input.writeConsent && input.confirmation === null) {
    return { kind: "proceed" };
  }

  if (input.confirmation === null) {
    return {
      kind: "confirm",
      summary: describeActionForConfirmation(input.action, input.adapterMatched),
    };
  }
  if (
    input.confirmation.actionId !== input.actionId ||
    input.confirmation.paramsHash !== input.paramsHash
  ) {
    return { kind: "refuse", reason: "confirmation_mismatch" };
  }
  if (!input.confirmation.approved) {
    return { kind: "refuse", reason: "declined_by_user" };
  }
  return { kind: "proceed" };
}
