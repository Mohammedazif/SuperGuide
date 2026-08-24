import type { ExpectOutcome, ExpectPredicate, PageDigest } from "@superguide/contract/public";
import { queryJsonPath } from "./json-path.js";

export interface ExpectEvidence {
  httpStatus: number | null;
  body: unknown;
  url: string | null;
  capabilityStatus: "ok" | "failed" | null;
  digest: PageDigest | null;
}

export type RuleVerdict =
  | { kind: "satisfied"; detail: string }
  | { kind: "violated"; detail: string }
  | { kind: "inconclusive"; detail: string };

function equalValues(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left === "number" && typeof right === "string") return String(left) === right;
  if (typeof left === "string" && typeof right === "number") return left === String(right);
  if (left === null || right === null) return false;
  if (typeof left === "object" && typeof right === "object") {
    return JSON.stringify(left) === JSON.stringify(right);
  }
  return false;
}

export function evaluatePredicate(
  predicate: ExpectPredicate,
  evidence: ExpectEvidence,
): RuleVerdict {
  switch (predicate.kind) {
    case "http_status": {
      if (evidence.httpStatus === null) {
        return { kind: "inconclusive", detail: "no http status was observed" };
      }
      return predicate.in.includes(evidence.httpStatus)
        ? { kind: "satisfied", detail: `status ${String(evidence.httpStatus)} is one of ${predicate.in.join(", ")}` }
        : { kind: "violated", detail: `status ${String(evidence.httpStatus)} is not one of ${predicate.in.join(", ")}` };
    }

    case "json_path": {
      if (evidence.body === undefined) {
        return { kind: "inconclusive", detail: "no response body was observed" };
      }
      const query = queryJsonPath(evidence.body, predicate.path);
      if (!query.ok) return { kind: "inconclusive", detail: `path could not be read: ${query.reason}` };

      if (predicate.exists === true) {
        return query.values.length > 0
          ? { kind: "satisfied", detail: `${predicate.path} is present` }
          : { kind: "violated", detail: `${predicate.path} is absent` };
      }
      if (predicate.exists === false) {
        return query.values.length === 0
          ? { kind: "satisfied", detail: `${predicate.path} is absent as required` }
          : { kind: "violated", detail: `${predicate.path} is present but should not be` };
      }
      if (predicate.equals === undefined) {
        return { kind: "inconclusive", detail: "the predicate states neither equals nor exists" };
      }
      if (query.values.length === 0) {
        return { kind: "violated", detail: `${predicate.path} is absent, so it cannot equal the expected value` };
      }
      const matched = query.values.some((value) => equalValues(value, predicate.equals));
      return matched
        ? { kind: "satisfied", detail: `${predicate.path} equals ${JSON.stringify(predicate.equals)}` }
        : {
            kind: "violated",
            detail: `${predicate.path} is ${JSON.stringify(query.values[0])}, not ${JSON.stringify(predicate.equals)}`,
          };
    }

    case "url_matches": {
      if (evidence.url === null) return { kind: "inconclusive", detail: "no url was reported" };
      let expression: RegExp;
      try {
        expression = new RegExp(predicate.pattern);
      } catch {
        return { kind: "inconclusive", detail: `pattern ${predicate.pattern} is not a valid expression` };
      }
      return expression.test(evidence.url)
        ? { kind: "satisfied", detail: `${evidence.url} matches ${predicate.pattern}` }
        : { kind: "violated", detail: `${evidence.url} does not match ${predicate.pattern}` };
    }

    case "capability_status": {
      if (evidence.capabilityStatus === null) {
        return { kind: "inconclusive", detail: "the client reported no status" };
      }
      return evidence.capabilityStatus === predicate.status
        ? { kind: "satisfied", detail: "the client reported success" }
        : { kind: "violated", detail: "the client reported a failure" };
    }

    case "element_state": {
      if (evidence.digest === null) {
        return { kind: "inconclusive", detail: "no page digest was supplied" };
      }
      const needle = predicate.nameContains.toLowerCase();
      const found = evidence.digest.elements.some(
        (element) => element.role === predicate.role && element.name.toLowerCase().includes(needle),
      );
      if (found) {
        return { kind: "satisfied", detail: `a ${predicate.role} named like "${predicate.nameContains}" is present` };
      }
      return evidence.digest.truncated
        ? { kind: "inconclusive", detail: "the digest was capped, so absence cannot be concluded" }
        : { kind: "violated", detail: `no ${predicate.role} named like "${predicate.nameContains}" is present` };
    }

    default: {
      const exhaustive: never = predicate;
      throw new Error(`unhandled predicate: ${JSON.stringify(exhaustive)}`);
    }
  }
}

export type RulesOutcome =
  | { decided: true; outcome: ExpectOutcome }
  | { decided: false; details: string[] };

// A client-reported success is one input here, never a completion claim on its own.
export function evaluateWithRules(
  predicates: readonly ExpectPredicate[],
  evidence: ExpectEvidence,
): RulesOutcome {
  if (predicates.length === 0) {
    return {
      decided: true,
      outcome: {
        satisfied: false,
        evaluatedBy: "rules",
        detail: "the action carried no success criterion, so nothing could be confirmed",
      },
    };
  }

  const details: string[] = [];
  let inconclusive = false;

  for (const predicate of predicates) {
    const verdict = evaluatePredicate(predicate, evidence);
    details.push(verdict.detail);
    if (verdict.kind === "violated") {
      return {
        decided: true,
        outcome: { satisfied: false, evaluatedBy: "rules", detail: verdict.detail },
      };
    }
    if (verdict.kind === "inconclusive") inconclusive = true;
  }

  if (inconclusive) return { decided: false, details };

  return {
    decided: true,
    outcome: { satisfied: true, evaluatedBy: "rules", detail: details.join("; ") },
  };
}
