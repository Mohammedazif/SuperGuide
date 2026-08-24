import type { ExecutorAction, LadderLevel, SgEvent, SgEventName } from "@superguide/contract/public";
import type { Database } from "../db/client.js";
import { withProduct } from "../db/client.js";
import { readJournalSince } from "../repository/journal.js";
import type { AppLogger } from "../logging.js";
import type { DurableNotifier } from "./notifier.js";
import type { EphemeralBus } from "./ephemeral.js";

export const HEARTBEAT_INTERVAL_MS = 20_000;

export interface StreamSink {
  write(chunk: string): void;
  end(): void;
}

export interface ConversationLifecycle {
  activeTurnId: string | null;
  resolutionState: string;
}

export interface OutstandingCall {
  turnId: string;
  action: ExecutorAction;
  ladderLevel: LadderLevel;
}

export interface ConversationStreamOptions {
  db: Database;
  lifecycle?: () => Promise<ConversationLifecycle | null>;
  outstandingCalls?: () => OutstandingCall[];
  outstandingConfirmations?: () => SgEvent[];
  notifier: DurableNotifier;
  ephemeral: EphemeralBus;
  logger: AppLogger;
  productId: string;
  conversationId: string;
  lastEventId: number;
  sink: StreamSink;
  heartbeatIntervalMs?: number;
}

function frame(id: number | null, name: SgEventName, payload: SgEvent): string {
  const idLine = id === null ? "" : `id: ${id}\n`;
  return `${idLine}event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
}

export class ConversationStream {
  readonly #options: ConversationStreamOptions;
  #lastSentSeq: number;
  #lastAssistantText = "";
  #draining = false;
  #drainRequested = false;
  #closed = false;
  #unsubscribeDurable: (() => void) | null = null;
  #unsubscribeEphemeral: (() => void) | null = null;
  #heartbeat: NodeJS.Timeout | null = null;

  constructor(options: ConversationStreamOptions) {
    this.#options = options;
    this.#lastSentSeq = options.lastEventId;
  }

  get lastSentSeq(): number {
    return this.#lastSentSeq;
  }

  // Read through methods: TypeScript keeps narrowing a private field across await, and these
  // flags are changed by close() and by notification handlers while a drain is suspended.
  #isClosed(): boolean {
    return this.#closed;
  }

  #isDrainRequested(): boolean {
    return this.#drainRequested;
  }

  async open(): Promise<void> {
    const { notifier, ephemeral, conversationId, sink } = this.#options;

    this.#unsubscribeDurable = notifier.subscribe(conversationId, () => {
      this.#requestDrain();
    });
    this.#unsubscribeEphemeral = ephemeral.subscribe(conversationId, (event) => {
      this.#writeEphemeral(event);
    });

    sink.write(": stream open\n\n");

    const interval = this.#options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
    this.#heartbeat = setInterval(() => {
      if (this.#closed) return;
      sink.write(": heartbeat\n\n");
    }, interval);
    this.#heartbeat.unref();

    await this.#drain();
    this.#announceOutstandingCalls();
    this.#announceOutstandingConfirmations();
    await this.#announceSettledTurn();
  }

  #announceOutstandingCalls(): void {
    const outstanding = this.#options.outstandingCalls;
    if (outstanding === undefined || this.#isClosed()) return;

    for (const call of outstanding()) {
      this.#options.sink.write(
        frame(null, "action.executing", {
          event: "action.executing",
          turnId: call.turnId,
          action: call.action,
          ladderLevel: call.ladderLevel,
        }),
      );
    }
  }

  // An ephemeral turn.finished only reaches connections that were attached when it was
  // published. A client that connects after a fast turn would otherwise wait forever, so the
  // settled state is read from the database and announced once on connect.
  #announceOutstandingConfirmations(): void {
    const outstanding = this.#options.outstandingConfirmations;
    if (outstanding === undefined || this.#isClosed()) return;
    for (const event of outstanding()) {
      this.#options.sink.write(frame(null, event.event, event));
    }
  }

  async #announceSettledTurn(): Promise<void> {
    const lifecycle = this.#options.lifecycle;
    if (lifecycle === undefined || this.#isClosed()) return;

    try {
      const current = await lifecycle();
      if (current === null || current.activeTurnId !== null) return;
      if (current.resolutionState === "in_progress") return;

      this.#options.sink.write(
        frame(null, "turn.finished", {
          event: "turn.finished",
          turnId: "00000000-0000-4000-8000-000000000000",
          resolutionState: current.resolutionState as "resolved",
          summary: this.#lastAssistantText,
        }),
      );
    } catch (error) {
      this.#options.logger.warn({ err: error }, "the settled turn state could not be read");
    }
  }

  close(finalEvent?: { name: SgEventName; payload: SgEvent }): void {
    if (this.#closed) return;
    this.#closed = true;

    if (finalEvent !== undefined) {
      this.#options.sink.write(frame(null, finalEvent.name, finalEvent.payload));
    }
    if (this.#heartbeat !== null) clearInterval(this.#heartbeat);
    this.#unsubscribeDurable?.();
    this.#unsubscribeEphemeral?.();
    this.#options.sink.end();
  }

  #writeEphemeral(event: SgEvent): void {
    if (this.#closed) return;
    this.#options.sink.write(frame(null, event.event, event));
  }

  #requestDrain(): void {
    if (this.#closed) return;
    this.#drainRequested = true;
    void this.#drain();
  }

  async #drain(): Promise<void> {
    if (this.#draining || this.#closed) return;
    this.#draining = true;

    try {
      do {
        this.#drainRequested = false;
        const entries = await withProduct(this.#options.db, this.#options.productId, (tx) =>
          readJournalSince(tx, this.#options.conversationId, this.#lastSentSeq),
        );

        for (const entry of entries) {
          if (this.#isClosed()) return;
          if (entry.seq <= this.#lastSentSeq) continue;

          if (entry.kind === "message") {
            if (entry.message.role === "assistant") this.#lastAssistantText = entry.message.content.text;
            this.#options.sink.write(
              frame(entry.seq, "message.completed", {
                event: "message.completed",
                message: entry.message,
              }),
            );
          } else {
            this.#options.sink.write(
              frame(entry.seq, "step.recorded", {
                event: "step.recorded",
                step: {
                  id: entry.step.id,
                  seq: entry.step.seq,
                  turnId: entry.step.turnId,
                  action: entry.step.action,
                  policyVerdict: entry.step.policyVerdict,
                  expectOutcome: entry.step.expectOutcome,
                  createdAt: entry.step.createdAt,
                },
              }),
            );
          }
          this.#lastSentSeq = entry.seq;
        }
      } while (this.#isDrainRequested() && !this.#isClosed());
    } catch (error) {
      this.#options.logger.error({ err: error }, "stream drain failed");
    } finally {
      this.#draining = false;
    }
  }
}

export class StreamRegistry {
  readonly #streams = new Set<ConversationStream>();

  add(stream: ConversationStream): () => void {
    this.#streams.add(stream);
    return () => this.#streams.delete(stream);
  }

  get size(): number {
    return this.#streams.size;
  }

  closeAll(finalEvent: { name: SgEventName; payload: SgEvent }): number {
    const streams = [...this.#streams];
    this.#streams.clear();
    for (const stream of streams) stream.close(finalEvent);
    return streams.length;
  }
}
