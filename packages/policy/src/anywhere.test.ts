import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { AgentAction, Confirmation, PolicyInput } from "@superguide/contract/anywhere";
import { describeActionForConfirmation, evaluateAnywherePolicy } from "./anywhere.js";

const ACTION_ID = "6b3a1a51-52a5-4d11-9f5a-1a3a35a3a001";
const OTHER_ACTION_ID = "6b3a1a51-52a5-4d11-9f5a-1a3a35a3a002";
const HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);
const TARGET = { id: "e00000001" };

const CLICK: AgentAction = { kind: "click", target: TARGET };
const READ_BACK: AgentAction = { kind: "readBack", target: TARGET };

function input(overrides: Partial<PolicyInput>): PolicyInput {
  return {
    actionId: ACTION_ID,
    action: CLICK,
    paramsHash: HASH,
    risk: "write",
    adapterMatched: true,
    siteActivated: true,
    tier: "control",
    writeConsent: false,
    confirmation: null,
    ...overrides,
  };
}

describe("evaluateAnywherePolicy", () => {
  it("refuses everything on a site that is not activated", () => {
    expect(evaluateAnywherePolicy(input({ siteActivated: false, risk: "read" }))).toEqual({
      kind: "refuse",
      reason: "site_not_activated",
    });
  });

  it("proceeds with read actions", () => {
    expect(evaluateAnywherePolicy(input({ risk: "read" }))).toEqual({ kind: "proceed" });
  });

  it("permits readBack and waitFor under an observe grant", () => {
    expect(evaluateAnywherePolicy(input({ tier: "observe", action: READ_BACK, risk: "read" }))).toEqual({
      kind: "proceed",
    });
    expect(
      evaluateAnywherePolicy(
        input({
          tier: "observe",
          risk: "read",
          action: {
            kind: "waitFor",
            predicate: { kind: "url-matches", contains: "/settings" },
            timeoutMs: 1000,
          },
        }),
      ),
    ).toEqual({ kind: "proceed" });
  });

  it("asks before a write, naming perception when no adapter matched", () => {
    const matched = evaluateAnywherePolicy(input({}));
    expect(matched.kind).toBe("confirm");
    const unmatched = evaluateAnywherePolicy(input({ adapterMatched: false }));
    expect(unmatched.kind).toBe("confirm");
    expect(unmatched.kind === "confirm" && unmatched.summary).toContain(
      "working from what the agent can see",
    );
    expect(matched.kind === "confirm" && matched.summary).not.toContain(
      "working from what the agent can see",
    );
  });

  it("asks before a sensitive action, even after write consent", () => {
    expect(evaluateAnywherePolicy(input({ risk: "sensitive" })).kind).toBe("confirm");
    expect(evaluateAnywherePolicy(input({ risk: "sensitive", writeConsent: true })).kind).toBe("confirm");
  });

  it("lets a later write proceed once the turn already has write consent", () => {
    expect(evaluateAnywherePolicy(input({ writeConsent: true }))).toEqual({ kind: "proceed" });
  });

  it("does not let write consent override an observe grant", () => {
    expect(evaluateAnywherePolicy(input({ tier: "observe", writeConsent: true }))).toEqual({
      kind: "refuse",
      reason: "grant_insufficient",
    });
  });

  it("rejects a confirmation bound to a different action", () => {
    const confirmation: Confirmation = {
      actionId: OTHER_ACTION_ID,
      paramsHash: HASH,
      approved: true,
    };
    expect(evaluateAnywherePolicy(input({ confirmation }))).toEqual({
      kind: "refuse",
      reason: "confirmation_mismatch",
    });
  });

  it("rejects a confirmation whose paramsHash does not match the action being executed", () => {
    const confirmation: Confirmation = {
      actionId: ACTION_ID,
      paramsHash: OTHER_HASH,
      approved: true,
    };
    expect(evaluateAnywherePolicy(input({ confirmation }))).toEqual({
      kind: "refuse",
      reason: "confirmation_mismatch",
    });
  });

  it("treats a declined confirmation as a refusal, not a retry", () => {
    const confirmation: Confirmation = { actionId: ACTION_ID, paramsHash: HASH, approved: false };
    expect(evaluateAnywherePolicy(input({ confirmation }))).toEqual({
      kind: "refuse",
      reason: "declined_by_user",
    });
  });

  it("proceeds when the confirmation matches this action and this paramsHash", () => {
    const confirmation: Confirmation = { actionId: ACTION_ID, paramsHash: HASH, approved: true };
    expect(evaluateAnywherePolicy(input({ confirmation }))).toEqual({ kind: "proceed" });
    expect(evaluateAnywherePolicy(input({ risk: "sensitive", confirmation }))).toEqual({ kind: "proceed" });
  });
});

describe("no input combination reaches proceed for a state-changing action under observe", () => {
  const syntheticIdArb = fc
    .integer({ min: 0, max: 0xffffffff })
    .map((value) => `e${value.toString(16).padStart(8, "0")}`);
  const targetArb = syntheticIdArb.map((id) => ({ id }));

  const stateChangingActionArb: fc.Arbitrary<AgentAction> = fc.oneof(
    targetArb.map((target): AgentAction => ({ kind: "click", target })),
    fc
      .record({ target: targetArb, value: fc.string({ maxLength: 40 }) })
      .map((parts): AgentAction => ({ kind: "type", ...parts })),
    fc
      .record({ target: targetArb, optionLabel: fc.string({ minLength: 1, maxLength: 20 }) })
      .map((parts): AgentAction => ({ kind: "select", ...parts })),
    fc
      .record({ target: targetArb, checked: fc.boolean() })
      .map((parts): AgentAction => ({ kind: "check", ...parts })),
    targetArb.map((target): AgentAction => ({ kind: "focus", target })),
    targetArb.map((target): AgentAction => ({ kind: "scrollIntoView", target })),
    fc
      .string({ maxLength: 30 })
      .map((suffix): AgentAction => ({ kind: "navigate", path: `/${suffix}` })),
  );

  const confirmationArb: fc.Arbitrary<Confirmation | null> = fc.option(
    fc.record({
      actionId: fc.constantFrom(ACTION_ID, OTHER_ACTION_ID),
      paramsHash: fc.constantFrom(HASH, OTHER_HASH),
      approved: fc.boolean(),
    }),
    { nil: null },
  );

  it("holds across the whole input space", () => {
    fc.assert(
      fc.property(
        stateChangingActionArb,
        fc.constantFrom("read" as const, "write" as const, "sensitive" as const),
        fc.boolean(),
        confirmationArb,
        fc.boolean(),
        (action, risk, adapterMatched, confirmation, writeConsent) => {
          const verdict = evaluateAnywherePolicy({
            actionId: ACTION_ID,
            action,
            paramsHash: HASH,
            risk,
            adapterMatched,
            siteActivated: true,
            tier: "observe",
            writeConsent,
            confirmation,
          });
          expect(verdict).toEqual({ kind: "refuse", reason: "grant_insufficient" });
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe("confirmation summaries", () => {
  it("describes every action kind", () => {
    const target = { id: "e00000001" };
    const actions: AgentAction[] = [
      { kind: "click", target },
      { kind: "type", target, value: "x" },
      { kind: "select", target, optionLabel: "One" },
      { kind: "check", target, checked: true },
      { kind: "check", target, checked: false },
      { kind: "focus", target },
      { kind: "scrollIntoView", target },
      { kind: "navigate", path: "/x" },
      { kind: "waitFor", predicate: { kind: "url-matches", contains: "/x" }, timeoutMs: 500 },
      { kind: "readBack", target },
    ];
    for (const action of actions) {
      expect(describeActionForConfirmation(action, true).length).toBeGreaterThan(4);
    }
  });

  it("throws on an action kind outside the closed vocabulary", () => {
    const forged = { kind: "detonate" } as unknown as AgentAction;
    expect(() => describeActionForConfirmation(forged, true)).toThrow(/unreachable action/);
  });
});
