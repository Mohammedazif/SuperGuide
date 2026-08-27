import type { Environment } from "../env.js";
import type { AppLogger } from "../logging.js";
import type { Database } from "../db/client.js";
import { withProduct } from "../db/client.js";
import type { EphemeralBus } from "../events/ephemeral.js";
import { setActiveTurn, setResolution } from "../repository/conversations.js";
import { appendMessage } from "../repository/journal.js";
import type { PendingCalls } from "./pending-calls.js";
import type { ConfirmationRegistry } from "./confirmations.js";
import type { TurnRunner, TurnStartInput } from "./types.js";
import { publicFailureMessage } from "../errors.js";
import type { ResolutionState } from "@superguide/contract/public";

export interface TurnExecutionContext extends TurnStartInput {
  signal: AbortSignal;
}

export interface TurnExecutionOutcome {
  resolutionState: ResolutionState;
  summary: string;
  closeConversation: boolean;
}

export type TurnExecutor = (context: TurnExecutionContext) => Promise<TurnExecutionOutcome>;

export interface TurnRunnerDependencies {
  env: Environment;
  logger: AppLogger;
  db: Database;
  ephemeral: EphemeralBus;
  pendingCalls: PendingCalls;
  confirmations: ConfirmationRegistry;
  execute: TurnExecutor;
}

interface ActiveTurn {
  controller: AbortController;
  settled: Promise<void>;
}

export function createAgentTurnRunner(deps: TurnRunnerDependencies): TurnRunner {
  const active = new Map<string, ActiveTurn>();

  const finish = async (
    input: TurnStartInput,
    outcome: TurnExecutionOutcome,
  ): Promise<void> => {
    // The turn itself writes what the person reads. The runner only records the outcome, so a
    // completed turn does not leave two copies of the same closing message.
    await withProduct(deps.db, input.productId, async (tx) => {
      await setResolution(
        tx,
        input.conversationId,
        outcome.resolutionState,
        outcome.closeConversation,
      );
      await setActiveTurn(tx, input.conversationId, null);
    });

    deps.ephemeral.publish(input.conversationId, {
      event: "turn.finished",
      turnId: input.turnId,
      resolutionState: outcome.resolutionState,
      summary: outcome.summary,
    });
  };

  const fail = async (input: TurnStartInput, error: unknown): Promise<void> => {
    const message = publicFailureMessage(error);
    deps.logger.error(
      { err: error, turnId: input.turnId, conversationId: input.conversationId },
      "turn failed",
    );

    try {
      await withProduct(deps.db, input.productId, async (tx) => {
        await appendMessage(tx, {
          conversationId: input.conversationId,
          productId: input.productId,
          role: "assistant",
          text:
            "Something went wrong while working on this and it did not complete. " +
            "A person has the full history of what was attempted.",
        });
        await setResolution(tx, input.conversationId, "escalated", true);
        await setActiveTurn(tx, input.conversationId, null);
      });
    } catch (writeError) {
      deps.logger.error({ err: writeError }, "could not record a failed turn");
    }

    deps.ephemeral.publish(input.conversationId, {
      event: "turn.failed",
      turnId: input.turnId,
      code: "turn_failed",
      message,
    });
  };

  return {
    start(input: TurnStartInput): void {
      const controller = new AbortController();

      deps.ephemeral.publish(input.conversationId, {
        event: "turn.started",
        turnId: input.turnId,
        conversationId: input.conversationId,
        startedAt: new Date().toISOString(),
      });

      const settled = (async () => {
        try {
          const outcome = await deps.execute({ ...input, signal: controller.signal });
          await finish(input, outcome);
        } catch (error) {
          await fail(input, error);
        } finally {
          active.delete(input.turnId);
        }
      })();

      active.set(input.turnId, { controller, settled });
    },

    cancel(turnId: string): boolean {
      const turn = active.get(turnId);
      if (turn === undefined) return false;
      turn.controller.abort();
      return true;
    },

    activeTurnCount(): number {
      return active.size;
    },

    async drain(timeoutMs: number): Promise<void> {
      if (active.size === 0) return;
      const pending = [...active.values()].map((turn) => turn.settled);
      let timer: NodeJS.Timeout | undefined;
      const deadline = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref();
      });
      await Promise.race([Promise.all(pending).then(() => undefined), deadline]);
      if (timer !== undefined) clearTimeout(timer);

      for (const turn of active.values()) turn.controller.abort();
    },
  };
}
