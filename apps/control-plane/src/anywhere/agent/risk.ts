import type { AgentAction, PageDigest, RiskClass } from "@superguide/contract/anywhere";
import { isSensitiveText, SENSITIVE_TERMS } from "@superguide/policy";

export { SENSITIVE_TERMS };

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
      if (name !== null && isSensitiveText(name)) return "sensitive";
      return "write";
    }
    default: {
      const exhausted: never = action;
      void exhausted;
      return "sensitive";
    }
  }
}
