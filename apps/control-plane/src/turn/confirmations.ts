import type { ConfirmationDecision, PolicyVerdict } from "@superguide/contract/public";

interface PendingConfirmation {
  conversationId: string;
  paramsHash: string;
  settle: (decision: ConfirmationDecision) => void;
  timer: NodeJS.Timeout;
  announcement: OutstandingConfirmation | null;
}

export interface OutstandingConfirmation {
  turnId: string;
  toolCallId: string;
  paramsHash: string;
  verdict: PolicyVerdict;
  preview: string;
  expiresAt: string;
}

export type ConfirmationOutcome =
  | { status: "accepted" }
  | { status: "unknown_call" }
  | { status: "params_mismatch" };

export class ConfirmationRegistry {
  readonly #pending = new Map<string, PendingConfirmation>();

  request(
    toolCallId: string,
    conversationId: string,
    paramsHash: string,
    timeoutMs: number,
    announcement: OutstandingConfirmation | null = null,
  ): Promise<ConfirmationDecision> {
    return new Promise<ConfirmationDecision>((resolve) => {
      const settle = (decision: ConfirmationDecision): void => {
        const entry = this.#pending.get(toolCallId);
        if (entry === undefined) return;
        clearTimeout(entry.timer);
        this.#pending.delete(toolCallId);
        resolve(decision);
      };

      const timer = setTimeout(() => {
        settle("timeout");
      }, timeoutMs);
      timer.unref();

      this.#pending.set(toolCallId, { conversationId, paramsHash, settle, timer, announcement });
    });
  }

  // The server recomputes paramsHash from the action it proposed, so an approval is bound to
  // one action's exact parameters. Nothing in this registry can outlive a single decision.
  decide(
    conversationId: string,
    toolCallId: string,
    paramsHash: string,
    decision: ConfirmationDecision,
  ): ConfirmationOutcome {
    const entry = this.#pending.get(toolCallId);
    if (entry === undefined || entry.conversationId !== conversationId) {
      return { status: "unknown_call" };
    }
    if (entry.paramsHash !== paramsHash) return { status: "params_mismatch" };
    entry.settle(decision);
    return { status: "accepted" };
  }

  // A confirmation asked for on an ephemeral channel would be lost to a client that attaches a
  // moment later, and the person would never be asked. Outstanding requests are re-announced.
  outstandingFor(conversationId: string): OutstandingConfirmation[] {
    const found: OutstandingConfirmation[] = [];
    for (const entry of this.#pending.values()) {
      if (entry.conversationId !== conversationId) continue;
      if (entry.announcement !== null) found.push(entry.announcement);
    }
    return found;
  }

  abandonAll(decision: ConfirmationDecision): number {
    let count = 0;
    for (const entry of [...this.#pending.values()]) {
      entry.settle(decision);
      count += 1;
    }
    return count;
  }
}
