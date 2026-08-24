import type { ExecutorAction, PageDigest, ToolResultPayload } from "@superguide/contract/public";
import type { ActionExecutor } from "@superguide/executor";
import type { NamespacedStorage } from "./storage.js";
import type { Transport } from "./transport.js";

export const PENDING_NAMESPACE = "pending";
export const DELIVERED_NAMESPACE = "delivered";
export const DELIVERED_TTL_MS = 10 * 60_000;

export interface PendingRecord {
  conversationId: string;
  toolCallId: string;
  actionType: ExecutorAction["type"];
  urlAtDispatch: string;
  startedAt: number;
}

export interface DispatcherOptions {
  transport: Transport;
  storage: NamespacedStorage;
  executor: ActionExecutor;
  currentUrl: () => string;
  now?: () => number;
  onDelivered?: (toolCallId: string, payload: ToolResultPayload) => void;
  onLog?: (message: string, detail?: unknown) => void;
}

function navigationInterrupted(url: string, digest: PageDigest | null): ToolResultPayload {
  return {
    status: "failed",
    error: {
      code: "NAV_INTERRUPTED",
      message: "the page navigated before this action reported a result",
    },
    digest,
    url,
  };
}

export class ToolDispatcher {
  readonly #options: DispatcherOptions;
  readonly #now: () => number;

  constructor(options: DispatcherOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => Date.now());
  }

  inFlight(): PendingRecord[] {
    return this.#options.storage
      .entries<PendingRecord>(PENDING_NAMESPACE)
      .map((entry) => entry.value);
  }

  async dispatch(conversationId: string, action: ExecutorAction): Promise<void> {
    if (this.#alreadyDelivered(action.toolCallId)) {
      this.#options.onLog?.("skipping a call that was already delivered", action.toolCallId);
      return;
    }

    const record: PendingRecord = {
      conversationId,
      toolCallId: action.toolCallId,
      actionType: action.type,
      urlAtDispatch: this.#options.currentUrl(),
      startedAt: this.#now(),
    };

    // Written before the action runs. If the page navigates mid-action there is still a record
    // saying a result is owed, and the server is told rather than left waiting.
    this.#options.storage.write(PENDING_NAMESPACE, action.toolCallId, record);

    const outcome = await this.#options.executor.execute(action);

    const payload: ToolResultPayload =
      outcome.status === "ok"
        ? { status: "ok", data: outcome.data, digest: outcome.digest, url: outcome.url }
        : {
            status: "failed",
            error: outcome.error,
            digest: outcome.digest,
            url: outcome.url,
          };

    await this.deliver(conversationId, action.toolCallId, payload);
  }

  async deliver(
    conversationId: string,
    toolCallId: string,
    payload: ToolResultPayload,
    options: { keepalive?: boolean } = {},
  ): Promise<void> {
    const result = await this.#options.transport.toolResult(
      conversationId,
      toolCallId,
      payload,
      options,
    );

    if (result.ok) {
      this.#options.storage.remove(PENDING_NAMESPACE, toolCallId);
      this.#options.storage.write(DELIVERED_NAMESPACE, toolCallId, true, DELIVERED_TTL_MS);
      this.#options.onDelivered?.(toolCallId, payload);
      return;
    }

    // A delivery that never lands would strand the turn, so the record stays for boot to retry.
    this.#options.onLog?.("a tool result could not be delivered", result);
  }

  reportInterruptedByNavigation(): void {
    const url = this.#options.currentUrl();

    for (const record of this.inFlight()) {
      const body = JSON.stringify({
        conversationId: record.conversationId,
        toolCallId: record.toolCallId,
        result: navigationInterrupted(url, null),
      });

      try {
        void this.#options.transport.fetch(this.#options.transport.url("/v1/tool-result"), {
          method: "POST",
          headers: this.#options.transport.headers(),
          body,
          keepalive: true,
        });
      } catch (error) {
        this.#options.onLog?.("a navigation report could not be sent", error);
      }
    }
  }

  // Navigation is the normal outcome of a correct navigate action, not a failure. On boot, a
  // pending navigation whose destination was actually reached is reported as the success it was.
  async replayPending(digest: PageDigest | null): Promise<number> {
    const url = this.#options.currentUrl();
    let replayed = 0;

    for (const record of this.inFlight()) {
      if (this.#alreadyDelivered(record.toolCallId)) {
        this.#options.storage.remove(PENDING_NAMESPACE, record.toolCallId);
        continue;
      }

      const navigated = record.urlAtDispatch !== url;
      const payload: ToolResultPayload =
        record.actionType === "navigate_route" && navigated
          ? { status: "ok", data: { navigated: true }, digest, url }
          : navigationInterrupted(url, digest);

      await this.deliver(record.conversationId, record.toolCallId, payload);
      replayed += 1;
    }

    return replayed;
  }

  #alreadyDelivered(toolCallId: string): boolean {
    return this.#options.storage.read<boolean>(DELIVERED_NAMESPACE, toolCallId) === true;
  }
}
