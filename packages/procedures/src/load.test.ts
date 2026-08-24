import { describe, expect, it } from "vitest";
import { formatIssues, loadProcedure } from "./load.js";
import { parsePrecondition, preconditionHolds } from "./preconditions.js";
import { tieBreak } from "./match.js";

const VALID = `
id: update_billing_address
version: 3
title: Update the customer's billing address
when: user wants to change billing or invoice address
preconditions:
  - user.authenticated
  - user.role in [owner, billing_admin]
required_scopes:
  - billing:write
steps:
  - prefer_api:
      operation: updateBillingAddress
      params:
        account_id: "{{identity.account_id}}"
    else_ui:
      goal: Reach billing settings and update the address fields
      route: /settings/billing
      confirm_before: [Save changes]
policy:
  never: [delete_account, change_plan, issue_refund]
  confirm: [any write to payment_method]
  escalate_if: [payment declined, tax id mismatch]
success:
  - api:
      operation: getAccount
      json_path: $.billing_address.postal_code
      equals: "{{params.postal_code}}"
`;

describe("loading a procedure", () => {
  it("accepts the documented format", () => {
    const result = loadProcedure(VALID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.procedure.document.id).toBe("update_billing_address");
    expect(result.procedure.document.version).toBe(3);
    expect(result.procedure.document.policy.never).toContain("issue_refund");
    expect(result.procedure.preconditions).toEqual([
      { kind: "authenticated" },
      { kind: "role_in", roles: ["owner", "billing_admin"] },
    ]);
    expect(result.procedure.document.success).toHaveLength(1);
  });

  it("fails loudly on YAML that cannot be read", () => {
    const result = loadProcedure("id: [unclosed");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(formatIssues(result.issues)).toMatch(/could not be read/);
  });

  it("fails when a required field is missing rather than applying part of it", () => {
    const result = loadProcedure("id: billing\nversion: 1\ntitle: t\n");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.path)).toContain("when");
    expect(result.issues.map((issue) => issue.path)).toContain("steps");
  });

  it("rejects a precondition the system cannot actually check", () => {
    const result = loadProcedure(
      "id: x\nversion: 1\ntitle: t\nwhen: w\npreconditions:\n  - the user seems trustworthy\nsteps:\n  - prefer_api:\n      operation: getAccount\n",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(formatIssues(result.issues)).toMatch(/not a precondition this system can check/);
  });

  it("rejects an ambiguous procedure that names one operation twice", () => {
    const result = loadProcedure(
      "id: x\nversion: 1\ntitle: t\nwhen: w\nsteps:\n  - prefer_api:\n      operation: getAccount\n  - prefer_api:\n      operation: getAccount\n",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(formatIssues(result.issues)).toMatch(/more than one step/);
  });

  it("rejects a slug that is not a safe identifier", () => {
    const result = loadProcedure(
      "id: Update Billing\nversion: 1\ntitle: t\nwhen: w\nsteps:\n  - prefer_api:\n      operation: getAccount\n",
    );
    expect(result.ok).toBe(false);
  });
});

describe("preconditions", () => {
  it("reads every supported form", () => {
    expect(parsePrecondition("user.authenticated")).toEqual({
      ok: true,
      precondition: { kind: "authenticated" },
    });
    expect(parsePrecondition("user.verified")).toEqual({
      ok: true,
      precondition: { kind: "verified" },
    });
    expect(parsePrecondition("user.scope has billing:write")).toEqual({
      ok: true,
      precondition: { kind: "scope", scope: "billing:write" },
    });
    expect(parsePrecondition("user.role in []").ok).toBe(false);
  });

  it("decides each form against a subject", () => {
    const verified = { tier: "verified" as const, role: "owner", scopes: ["billing:write"] };
    const anonymous = { tier: "anonymous" as const, role: null, scopes: [] };

    expect(preconditionHolds({ kind: "authenticated" }, verified)).toBe(true);
    expect(preconditionHolds({ kind: "authenticated" }, anonymous)).toBe(false);
    expect(preconditionHolds({ kind: "verified" }, verified)).toBe(true);
    expect(preconditionHolds({ kind: "role_in", roles: ["owner"] }, verified)).toBe(true);
    expect(preconditionHolds({ kind: "role_in", roles: ["member"] }, verified)).toBe(false);
    expect(preconditionHolds({ kind: "role_in", roles: ["owner"] }, anonymous)).toBe(false);
    expect(preconditionHolds({ kind: "scope", scope: "billing:write" }, verified)).toBe(true);
    expect(preconditionHolds({ kind: "scope", scope: "seats:write" }, verified)).toBe(false);
  });
});

describe("the deterministic tie break", () => {
  const candidates = [
    { slug: "alpha", version: 2, title: "A", when: "a", preconditions: [] },
    {
      slug: "beta",
      version: 5,
      title: "B",
      when: "b",
      preconditions: [{ kind: "verified" as const }],
    },
  ];
  const subject = { tier: "verified" as const, role: "owner", scopes: [] };

  it("drops a candidate whose preconditions do not hold", () => {
    const decision = tieBreak({
      candidates,
      shortlist: [{ slug: "beta", confidence: 0.9 }],
      subject: { tier: "anonymous", role: null, scopes: [] },
    });
    expect(decision).toBeNull();
  });

  it("prefers more satisfied preconditions over raw confidence", () => {
    const decision = tieBreak({
      candidates,
      shortlist: [
        { slug: "alpha", confidence: 0.99 },
        { slug: "beta", confidence: 0.2 },
      ],
      subject,
    });
    expect(decision?.slug).toBe("beta");
  });

  it("gives the same answer for the same input every time", () => {
    const shortlist = [
      { slug: "alpha", confidence: 0.5 },
      { slug: "beta", confidence: 0.5 },
    ];
    const first = tieBreak({ candidates, shortlist, subject });
    const second = tieBreak({ candidates, shortlist: [...shortlist].reverse(), subject });
    expect(second).toEqual(first);
  });

  it("ignores a shortlist entry naming a procedure that does not exist", () => {
    expect(
      tieBreak({ candidates, shortlist: [{ slug: "ghost", confidence: 1 }], subject }),
    ).toBeNull();
  });
});
