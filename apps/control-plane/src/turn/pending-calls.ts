import type { ExecutorAction, LadderLevel, ToolResultPayload } from "@superguide/contract/public";

export type DeliveryOutcome = "accepted" | "duplicate" | "unknown_call";

interface PendingEntry {
  conversationId: string;
  settle: (payload: ToolResultPayload) => void;
  timer: NodeJS.Timeout;
  announcement: InFlightCall | null;
}

export interface InFlightCall {
  turnId: string;
  action: ExecutorAction;
  ladderLevel: LadderLevel;
}

export class PendingCalls {
  readonly #pending = new Map<string, PendingEntry>();
  readonly #delivered = new Map<string, number>();
  readonly #deliveredTtlMs: number;

  constructor(deliveredTtlMs = 10 * 60_000) {
    this.#deliveredTtlMs = deliveredTtlMs;
  }

  register(
    toolCallId: string,
    conversationId: string,
    timeoutMs: number,
    onTimeout: () => ToolResultPayload,
    announcement: InFlightCall | null = null,
  ): Promise<ToolResultPayload> {
    return new Promise<ToolResultPayload>((resolve) => {
      const settle = (payload: ToolResultPayload): void => {
        const entry = this.#pending.get(toolCallId);
        if (entry === undefined) return;
        clearTimeout(entry.timer);
        this.#pending.delete(toolCallId);
        this.#delivered.set(toolCallId, Date.now() + this.#deliveredTtlMs);
        resolve(payload);
      };

      const timer = setTimeout(() => {
        settle(onTimeout());
      }, timeoutMs);
      timer.unref();

      this.#pending.set(toolCallId, { conversationId, settle, timer, announcement });
    });
  }

  deliver(
    conversationId: string,
    toolCallId: string,
    payload: ToolResultPayload,
  ): DeliveryOutcome {
    this.#expireDelivered();

    const entry = this.#pending.get(toolCallId);
    if (entry === undefined) {
      return this.#delivered.has(toolCallId) ? "duplicate" : "unknown_call";
    }
    if (entry.conversationId !== conversationId) return "unknown_call";

    entry.settle(payload);
    return "accepted";
  }

  isInFlight(toolCallId: string): boolean {
    return this.#pending.has(toolCallId);
  }

  // A dispatch is announced on an ephemeral channel, which only reaches connections attached at
  // that moment. A client that attaches a moment later asks what is still outstanding, so an
  // action cannot be lost to that race.
  outstandingFor(conversationId: string): InFlightCall[] {
    const found: InFlightCall[] = [];
    for (const entry of this.#pending.values()) {
      if (entry.conversationId !== conversationId) continue;
      if (entry.announcement !== null) found.push(entry.announcement);
    }
    return found;
  }

  abandonConversation(conversationId: string, payload: ToolResultPayload): number {
    let count = 0;
    for (const [toolCallId, entry] of [...this.#pending]) {
      if (entry.conversationId !== conversationId) continue;
      entry.settle(payload);
      count += 1;
      void toolCallId;
    }
    return count;
  }

  abandonAll(payload: ToolResultPayload): number {
    let count = 0;
    for (const entry of [...this.#pending.values()]) {
      entry.settle(payload);
      count += 1;
    }
    return count;
  }

  #expireDelivered(): void {
    const now = Date.now();
    for (const [toolCallId, expiresAt] of [...this.#delivered]) {
      if (expiresAt <= now) this.#delivered.delete(toolCallId);
    }
  }
}
