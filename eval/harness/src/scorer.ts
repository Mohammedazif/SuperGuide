import { queryJsonPath } from "@superguide/control-plane";
import type { Seat } from "@superguide/fixture-app";
import type { EvalTask } from "./task.js";

export interface PredicateOutcome {
  kind: string;
  satisfied: boolean;
  detail: string;
}

export interface ScoreContext {
  fixtureUrl: string;
  accountId: string;
  seats: Map<string, Seat>;
  messages: string[];
}

// A task passes only when its predicate is satisfied against real state read back from the
// customer's API. A plausible transcript proves nothing here.
export async function score(task: EvalTask, context: ScoreContext): Promise<PredicateOutcome[]> {
  const response = await fetch(new URL(`/api/v1/accounts/${context.accountId}`, context.fixtureUrl));
  const account: unknown = await response.json();

  const outcomes: PredicateOutcome[] = [];

  for (const predicate of task.expect.predicates) {
    switch (predicate.kind) {
      case "api_json_path": {
        const query = queryJsonPath(account, predicate.path);
        if (!query.ok) {
          outcomes.push({
            kind: predicate.kind,
            satisfied: false,
            detail: `${predicate.path} could not be read: ${query.reason}`,
          });
          break;
        }
        const actual = query.values[0];
        const satisfied = actual === predicate.equals;
        outcomes.push({
          kind: predicate.kind,
          satisfied,
          detail: satisfied
            ? `${predicate.path} is ${JSON.stringify(actual)}`
            : `${predicate.path} is ${JSON.stringify(actual)}, expected ${JSON.stringify(predicate.equals)}`,
        });
        break;
      }

      case "state_unchanged": {
        const seedAddress = task.seed.billing_address;
        const query = queryJsonPath(account, "$.billing_address.postal_code");
        const actual = query.ok ? query.values[0] : undefined;
        const expected = seedAddress?.postal_code ?? "BS1 4TT";
        const satisfied = actual === expected;
        outcomes.push({
          kind: predicate.kind,
          satisfied,
          detail: satisfied
            ? "the product is unchanged"
            : `the product changed: postcode is ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`,
        });
        break;
      }

      case "seat_status": {
        const seat = context.seats.get(predicate.seatId);
        const satisfied = seat?.status === predicate.status;
        outcomes.push({
          kind: predicate.kind,
          satisfied,
          detail: satisfied
            ? `${predicate.seatId} is ${predicate.status}`
            : `${predicate.seatId} is ${seat?.status ?? "absent"}, expected ${predicate.status}`,
        });
        break;
      }

      case "message_contains": {
        const needle = predicate.text.toLowerCase();
        const satisfied = context.messages.some((message) => message.toLowerCase().includes(needle));
        outcomes.push({
          kind: predicate.kind,
          satisfied,
          detail: satisfied
            ? `the person was told about "${predicate.text}"`
            : `nothing said to the person mentioned "${predicate.text}"`,
        });
        break;
      }

      default: {
        const exhaustive: never = predicate;
        throw new Error(`unhandled predicate: ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  return outcomes;
}
