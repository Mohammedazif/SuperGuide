import { describe, expect, it } from "vitest";
import type { AgentAction, RiskClass } from "@superguide/contract/public";
import {
  DEFAULT_PRODUCT_POLICY,
  describeAction,
  evaluatePolicy,
  previewFor,
  ruleMatches,
  tokenise,
  firstMatchingRule,
  type PolicyInput,
} from "./index.js";

function apiAction(risk: RiskClass, overrides: Partial<AgentAction> = {}): AgentAction {
  return {
    type: "call_api",
    toolCallId: "toolu_1",
    intent: "Update the billing address.",
    expect: [{ kind: "http_status", in: [200] }],
    risk,
    timeoutMs: 20_000,
    tool: "api_updateBillingAddress",
    arguments: { accountId: "acct_1", postal_code: "EH3 9DR" },
    ...overrides,
  } as AgentAction;
}

function input(overrides: Partial<PolicyInput> = {}): PolicyInput {
  return {
    action: apiAction("read", { risk: "read" }),
    toolName: "api_updateBillingAddress",
    compiledToolNames: ["api_updateBillingAddress", "api_getAccount"],
    requiredScopes: [],
    procedure: null,
    identity: { tier: "verified", scopes: [] },
    productPolicy: DEFAULT_PRODUCT_POLICY,
    signals: [],
    writeConsent: false,
    ...overrides,
  };
}

describe("evaluatePolicy", () => {
  it("blocks a tool that is not in the compiled vocabulary", () => {
    expect(evaluatePolicy(input({ toolName: "api_somethingElse" }))).toEqual({
      decision: "block",
      reason: "unknown_action",
    });
  });

  it("blocks a destructive action whatever the planner believed it was doing", () => {
    expect(evaluatePolicy(input({ action: apiAction("destructive") }))).toEqual({
      decision: "block",
      reason: "risk_class_blocked",
    });
  });

  it("blocks a financial action", () => {
    expect(evaluatePolicy(input({ action: apiAction("financial") }))).toEqual({
      decision: "block",
      reason: "risk_class_blocked",
    });
  });

  it("blocks what the procedure forbids, before identity is considered", () => {
    const verdict = evaluatePolicy(
      input({
        action: apiAction("write"),
        identity: { tier: "anonymous", scopes: [] },
        procedure: { never: ["update billing address"], confirm: [], escalateIf: [] },
      }),
    );
    expect(verdict).toEqual({ decision: "block", reason: "procedure_forbids" });
  });

  it("blocks a write from an identity that is not verified", () => {
    expect(
      evaluatePolicy(
        input({ action: apiAction("write"), identity: { tier: "unverified", scopes: [] } }),
      ),
    ).toEqual({ decision: "block", reason: "identity_insufficient" });
  });

  it("blocks a write from an anonymous session", () => {
    expect(
      evaluatePolicy(
        input({ action: apiAction("write"), identity: { tier: "anonymous", scopes: [] } }),
      ),
    ).toEqual({ decision: "block", reason: "identity_insufficient" });
  });

  it("allows a read from an anonymous session", () => {
    expect(
      evaluatePolicy(
        input({ action: apiAction("read"), identity: { tier: "anonymous", scopes: [] } }),
      ),
    ).toEqual({ decision: "allow" });
  });

  it("blocks when a required scope is missing", () => {
    expect(
      evaluatePolicy(
        input({
          action: apiAction("write"),
          requiredScopes: ["billing:write"],
          identity: { tier: "verified", scopes: ["billing:read"] },
        }),
      ),
    ).toEqual({ decision: "block", reason: "scope_missing" });
  });

  it("blocks on an escalation condition matched against a signal from the run", () => {
    expect(
      evaluatePolicy(
        input({
          action: apiAction("write"),
          identity: { tier: "verified", scopes: [] },
          procedure: { never: [], confirm: [], escalateIf: ["payment declined"] },
          signals: ["the gateway said the payment was declined"],
        }),
      ),
    ).toEqual({ decision: "block", reason: "escalation_condition" });
  });

  it("asks for confirmation when the procedure says to", () => {
    const verdict = evaluatePolicy(
      input({
        action: apiAction("read"),
        procedure: { never: [], confirm: ["update billing address"], escalateIf: [] },
      }),
    );
    expect(verdict.decision).toBe("confirm");
    if (verdict.decision === "confirm") expect(verdict.reason).toBe("procedure_confirm");
  });

  it("asks for confirmation before any write by default", () => {
    const verdict = evaluatePolicy(input({ action: apiAction("write") }));
    expect(verdict.decision).toBe("confirm");
    if (verdict.decision === "confirm") {
      expect(verdict.reason).toBe("write_requires_confirmation");
      expect(verdict.preview.length).toBeGreaterThan(0);
    }
  });

  it("allows a write without confirmation when the product has relaxed that default", () => {
    expect(
      evaluatePolicy(
        input({
          action: apiAction("write", { intent: "Update the display name.", tool: "api_updateDisplayName" }),
          toolName: "api_updateDisplayName",
          compiledToolNames: ["api_updateDisplayName"],
          productPolicy: { blockedRiskClasses: [], confirmEveryWrite: false },
        }),
      ),
    ).toEqual({ decision: "allow" });
  });

  it("still asks before a grounded click from an anonymous session", () => {
    const verdict = evaluatePolicy(
      input({
        action: {
          type: "click",
          toolCallId: "toolu_1",
          intent: "Open New Project.",
          expect: [{ kind: "capability_status", status: "ok" }],
          risk: "write",
          timeoutMs: 20_000,
          ref: "e1",
        },
        toolName: "ui_click",
        compiledToolNames: ["ui_click"],
        identity: { tier: "anonymous", scopes: [] },
      }),
    );
    expect(verdict.decision).toBe("confirm");
    if (verdict.decision === "confirm") expect(verdict.reason).toBe("write_requires_confirmation");
  });

  it("lets later ordinary writes through after one approval, like the extension", () => {
    expect(
      evaluatePolicy(
        input({
          action: {
            type: "click",
            toolCallId: "toolu_1",
            intent: "Go to the next step.",
            expect: [{ kind: "capability_status", status: "ok" }],
            risk: "write",
            timeoutMs: 20_000,
            ref: "e2",
          },
          toolName: "ui_click",
          compiledToolNames: ["ui_click"],
          writeConsent: true,
        }),
      ),
    ).toEqual({ decision: "allow" });
  });

  it("still asks before delete or buy after write consent", () => {
    const verdict = evaluatePolicy(
      input({
        action: {
          type: "click",
          toolCallId: "toolu_1",
          intent: "Delete this project.",
          expect: [{ kind: "capability_status", status: "ok" }],
          risk: "write",
          timeoutMs: 20_000,
          ref: "e1",
        },
        toolName: "ui_click",
        compiledToolNames: ["ui_click"],
        writeConsent: true,
      }),
    );
    expect(verdict.decision).toBe("confirm");
    if (verdict.decision === "confirm") expect(verdict.reason).toBe("write_requires_confirmation");
  });

  it("still asks before delete or buy even when every-write confirmation is off", () => {
    const verdict = evaluatePolicy(
      input({
        action: {
          type: "click",
          toolCallId: "toolu_1",
          intent: "Delete this project.",
          expect: [{ kind: "capability_status", status: "ok" }],
          risk: "write",
          timeoutMs: 20_000,
          ref: "e1",
        },
        toolName: "ui_click",
        compiledToolNames: ["ui_click"],
        productPolicy: { blockedRiskClasses: [], confirmEveryWrite: false },
      }),
    );
    expect(verdict.decision).toBe("confirm");
    if (verdict.decision === "confirm") expect(verdict.reason).toBe("write_requires_confirmation");
  });

  it("allows a read with every required scope held", () => {
    expect(
      evaluatePolicy(
        input({
          requiredScopes: ["billing:read"],
          identity: { tier: "verified", scopes: ["billing:read"] },
          procedure: { never: [], confirm: [], escalateIf: [] },
        }),
      ),
    ).toEqual({ decision: "allow" });
  });

  it("is a pure function of its input", () => {
    const subject = input({ action: apiAction("write") });
    const frozen = JSON.stringify(subject);
    const first = evaluatePolicy(subject);
    const second = evaluatePolicy(subject);
    expect(second).toEqual(first);
    expect(JSON.stringify(subject)).toBe(frozen);
  });
});

describe("action description and preview", () => {
  const cases: AgentAction[] = [
    apiAction("read"),
    {
      type: "invoke_capability",
      toolCallId: "t",
      intent: "i",
      expect: [{ kind: "capability_status", status: "ok" }],
      risk: "write",
      timeoutMs: 1000,
      capability: "open_seat_dialog",
      arguments: { seatId: "seat_1" },
    },
    {
      type: "navigate_route",
      toolCallId: "t",
      intent: "i",
      expect: [{ kind: "url_matches", pattern: "/settings" }],
      risk: "read",
      timeoutMs: 1000,
      routeId: "billing_settings",
      params: {},
    },
    {
      type: "ask_user",
      toolCallId: "t",
      intent: "i",
      expect: [{ kind: "capability_status", status: "ok" }],
      risk: "read",
      timeoutMs: 1000,
      question: "Which address?",
    },
    {
      type: "escalate",
      toolCallId: "t",
      intent: "i",
      expect: [{ kind: "capability_status", status: "ok" }],
      risk: "read",
      timeoutMs: 1000,
      reason: "unclear",
      summary: "s",
    },
    {
      type: "set_value",
      toolCallId: "t",
      intent: "i",
      expect: [{ kind: "capability_status", status: "ok" }],
      risk: "write",
      timeoutMs: 1000,
      ref: "e1",
      value: "v",
    },
    {
      type: "select_option",
      toolCallId: "t",
      intent: "i",
      expect: [{ kind: "capability_status", status: "ok" }],
      risk: "write",
      timeoutMs: 1000,
      ref: "e1",
      value: "v",
    },
    {
      type: "set_checked",
      toolCallId: "t",
      intent: "i",
      expect: [{ kind: "capability_status", status: "ok" }],
      risk: "write",
      timeoutMs: 1000,
      ref: "e1",
      checked: true,
    },
    {
      type: "click",
      toolCallId: "t",
      intent: "i",
      expect: [{ kind: "capability_status", status: "ok" }],
      risk: "read",
      timeoutMs: 1000,
      ref: "e1",
    },
    {
      type: "hover",
      toolCallId: "t",
      intent: "i",
      expect: [{ kind: "capability_status", status: "ok" }],
      risk: "read",
      timeoutMs: 1000,
      ref: "e1",
    },
    {
      type: "press_key",
      toolCallId: "t",
      intent: "i",
      expect: [{ kind: "capability_status", status: "ok" }],
      risk: "write",
      timeoutMs: 1000,
      key: "Enter",
    },
    {
      type: "scroll",
      toolCallId: "t",
      intent: "i",
      expect: [{ kind: "capability_status", status: "ok" }],
      risk: "read",
      timeoutMs: 1000,
      direction: "down",
    },
    {
      type: "wait_for",
      toolCallId: "t",
      intent: "i",
      expect: [{ kind: "capability_status", status: "ok" }],
      risk: "read",
      timeoutMs: 1000,
      role: "status",
      nameContains: "Saved",
    },
  ];

  it("describes and previews every action in the vocabulary", () => {
    for (const action of cases) {
      expect(describeAction(action, "tool").length).toBeGreaterThan(0);
      expect(previewFor(action).length).toBeGreaterThan(0);
    }
  });

  it("previews a checkbox being turned off as well as on", () => {
    const base: AgentAction = {
      type: "set_checked",
      toolCallId: "t",
      intent: "Turn the switch.",
      expect: [{ kind: "capability_status", status: "ok" }],
      risk: "write",
      timeoutMs: 1000,
      ref: "e1",
      checked: true,
    };
    expect(previewFor(base)).toContain("on");
    expect(previewFor({ ...base, checked: false })).toContain("off");
  });

  it("refuses an action type outside the union", () => {
    const rogue = { type: "run_script", risk: "read" } as unknown as AgentAction;
    expect(() => describeAction(rogue, "tool")).toThrow(/unhandled action/);
    expect(() => previewFor(rogue)).toThrow(/unhandled action/);
  });
});

describe("rule matching", () => {
  it("ignores filler words when matching a rule", () => {
    expect(ruleMatches("any write to payment_method", "call_api write payment method")).toBe(true);
    expect(ruleMatches("delete_account", "call_api delete account destructive")).toBe(true);
    expect(ruleMatches("issue_refund", "call_api update address write")).toBe(false);
  });

  it("treats a rule with no meaningful token as matching nothing", () => {
    expect(ruleMatches("the and of", "anything at all")).toBe(false);
    expect(tokenise("the and of")).toEqual([]);
  });

  it("returns the first rule that matches any subject", () => {
    expect(firstMatchingRule(["nope", "billing address"], ["update billing address"])).toBe(
      "billing address",
    );
    expect(firstMatchingRule(["nope"], ["update billing address"])).toBeNull();
  });
});
