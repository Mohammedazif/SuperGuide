import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { AgentAction } from "@superguide/contract/public";
import { withProduct, type Database } from "../db/client.js";
import type { AppLogger } from "../logging.js";
import { setActiveTurn, setResolution } from "../repository/conversations.js";
import { appendMessage, appendStep } from "../repository/journal.js";

const RESTART_MESSAGE =
  "This request was interrupted because the service restarted while it was running. " +
  "Nothing further was attempted, and a person has been given the full history.";

export function restartEscalationAction(turnId: string): AgentAction {
  return {
    type: "escalate",
    toolCallId: `restart-${turnId}`,
    intent: "Hand an interrupted turn to a human because the process restarted.",
    expect: [{ kind: "capability_status", status: "ok" }],
    risk: "read",
    timeoutMs: 1000,
    reason: "process_restart",
    summary: RESTART_MESSAGE,
  };
}

type InFlightTurn = Record<string, unknown> & {
  product_id: string;
  conversation_id: string;
  turn_id: string;
};

export async function recoverInFlightTurns(db: Database, logger: AppLogger): Promise<number> {
  let inFlight: InFlightTurn[];
  try {
    const result = await db.execute<InFlightTurn>(sql`SELECT * FROM sg_list_in_flight_turns()`);
    inFlight = result.rows;
  } catch (error) {
    logger.error({ err: error }, "could not list in-flight turns at startup");
    return 0;
  }

  let recovered = 0;

  for (const row of inFlight) {
    const conversation = { id: row.conversation_id, productId: row.product_id };
    const turnId = row.turn_id;

    try {
      await withProduct(db, conversation.productId, async (tx) => {
        await appendStep(tx, {
          conversationId: conversation.id,
          productId: conversation.productId,
          turnId,
          ladderLevel: "L6",
          action: restartEscalationAction(turnId),
          policyVerdict: { decision: "allow" },
          result: { status: "not_executed", code: "process_restart", message: RESTART_MESSAGE },
          expectOutcome: {
            satisfied: false,
            evaluatedBy: "rules",
            detail: "The process restarted before this turn could complete.",
          },
          model: null,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          latencyMs: 0,
          requestId: `restart-${randomUUID()}`,
        });

        await appendMessage(tx, {
          conversationId: conversation.id,
          productId: conversation.productId,
          role: "assistant",
          text: RESTART_MESSAGE,
        });

        await setResolution(tx, conversation.id, "escalated", true);
        await setActiveTurn(tx, conversation.id, null);
      });
      recovered += 1;
    } catch (error) {
      logger.error(
        { err: error, conversationId: conversation.id },
        "could not close an interrupted turn",
      );
    }
  }

  if (recovered > 0) logger.warn({ recovered }, "closed interrupted turns after restart");
  return recovered;
}
