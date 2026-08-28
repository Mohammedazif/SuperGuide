import type { AgentAction, PageDigest, RiskClass } from "@superguide/contract/anywhere";

export const SENSITIVE_TERMS: readonly string[] = [
  "2fa",
  "archive",
  "bank",
  "billing",
  "buy",
  "cancel",
  "card",
  "charge",
  "checkout",
  "close",
  "credential",
  "deactivate",
  "delete",
  "destroy",
  "downgrade",
  "erase",
  "grant",
  "iban",
  "impersonate",
  "invoice",
  "invite",
  "merge",
  "mfa",
  "overwrite",
  "owner",
  "password",
  "pay",
  "payment",
  "payout",
  "permanently",
  "permission",
  "plan",
  "production",
  "purchase",
  "purge",
  "recovery",
  "refund",
  "remove",
  "reset",
  "revoke",
  "role",
  "sepa",
  "ssn",
  "subscribe",
  "suspend",
  "tax",
  "terminate",
  "totp",
  "transfer",
  "unsubscribe",
  "upgrade",
  "wipe",
  "wire",
];

const SENSITIVE_NAME = new RegExp(`\\b(?:${SENSITIVE_TERMS.join("|")})\\b`, "i");

function targetName(id: string, digest: PageDigest | null): string | null {
  if (digest === null) return null;
  const name = digest.nodes.find((candidate) => candidate.id === id)?.name.trim();
  return name === undefined || name.length === 0 ? null : name;
}

export function classifyRisk(action: AgentAction, digest: PageDigest | null): RiskClass {
  switch (action.kind) {
    case "readBack":
    case "waitFor":
    case "focus":
    case "scrollIntoView":
      return "read";
    case "navigate":
      return "write";
    case "click":
    case "type":
    case "select":
    case "check": {
      const name = targetName(action.target.id, digest);
      if (name === null) return "sensitive";
      return SENSITIVE_NAME.test(name) ? "sensitive" : "write";
    }
    default: {
      const exhausted: never = action;
      void exhausted;
      return "sensitive";
    }
  }
}
