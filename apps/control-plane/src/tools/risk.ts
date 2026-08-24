import type { RiskClass } from "@superguide/contract/public";
import type { HttpMethod } from "@superguide/contract/internal";

const FINANCIAL = /payment|invoice|refund|subscription|charge/i;
const COMMUNICATION = /email|sms|notify|message|invite/i;

const STRENGTH: Record<RiskClass, number> = {
  read: 0,
  write: 1,
  communication: 2,
  financial: 3,
  destructive: 4,
};

export function strongestRisk(candidates: readonly RiskClass[]): RiskClass {
  let strongest: RiskClass = "read";
  for (const candidate of candidates) {
    if (STRENGTH[candidate] > STRENGTH[strongest]) strongest = candidate;
  }
  return strongest;
}

// The tool definition assigns the class, never the model. A DELETE is destructive whatever
// the planner believes it is doing.
export function riskForOperation(
  method: HttpMethod,
  path: string,
  operationId: string,
): RiskClass {
  const candidates: RiskClass[] = [];

  switch (method) {
    case "GET":
    case "HEAD":
      candidates.push("read");
      break;
    case "POST":
    case "PUT":
    case "PATCH":
      candidates.push("write");
      break;
    case "DELETE":
      candidates.push("destructive");
      break;
    default: {
      const exhaustive: never = method;
      throw new Error(`unhandled method: ${String(exhaustive)}`);
    }
  }

  const subject = `${path} ${operationId}`;
  if (FINANCIAL.test(subject)) candidates.push("financial");
  if (COMMUNICATION.test(subject)) candidates.push("communication");

  return strongestRisk(candidates);
}
