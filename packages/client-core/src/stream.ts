import { sgEventSchema, type SgEvent } from "@superguide/contract/public";
import type { Transport } from "./transport.js";

export interface StreamHandlers {
  onEvent(event: SgEvent): void;
  onOpen?(): void;
  onGone?(): void;
  onError?(detail: string): void;
}

export interface StreamOptions {
  baseDelayMs?: number;
  maximumDelayMs?: number;
  jitter?: () => number;
  now?: () => number;
}

interface ParsedFrame {
  id: number | null;
  event: string;
  data: string;
}

function parseBlock(block: string): ParsedFrame | null {
  if (block.startsWith(":")) return null;

  let id: number | null = null;
  let event = "message";
  const data: string[] = [];

  for (const line of block.split("\n")) {
    if (line.startsWith("id:")) {
      const value = Number(line.slice(3).trim());
      if (Number.isFinite(value)) id = value;
    } else if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      data.push(line.slice(5).replace(/^ /, ""));
    }
  }

  if (data.length === 0) return null;
  return { id, event, data: data.join("\n") };
}

export class ConversationStreamClient {
  readonly #transport: Transport;
  readonly #handlers: StreamHandlers;
  readonly #options: StreamOptions;
  #controller: AbortController | null = null;
  #lastEventId: number = 0;
  #attempts = 0;
  #stopped = false;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #conversationId: string | null = null;

  constructor(transport: Transport, handlers: StreamHandlers, options: StreamOptions = {}) {
    this.#transport = transport;
    this.#handlers = handlers;
    this.#options = options;
  }

  get lastEventId(): number {
    return this.#lastEventId;
  }

  // Read via method: TS private-field narrowing does not survive await; stop() can race.
  #isStopped(): boolean {
    return this.#stopped;
  }

  connect(conversationId: string): void {
    this.#conversationId = conversationId;
    this.#stopped = false;
    void this.#open();
  }

  // Reconnect serves durable rows only; text deltas are best-effort and never replayed.
  reconnectNow(): void {
    if (this.#stopped || this.#conversationId === null) return;
    this.#controller?.abort();
    void this.#open();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#reconnectTimer !== null) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
    this.#controller?.abort();
    this.#controller = null;
  }

  async #open(): Promise<void> {
    const conversationId = this.#conversationId;
    if (conversationId === null || this.#stopped) return;

    const controller = new AbortController();
    this.#controller = controller;

    const url = new URL(this.#transport.url("/v1/stream"));
    url.searchParams.set("conversationId", conversationId);
    const headers = this.#transport.headers(
      this.#lastEventId > 0 ? { "last-event-id": String(this.#lastEventId) } : {},
    );

    let response: Response;
    try {
      response = await this.#transport.fetch(url.toString(), {
        headers,
        signal: controller.signal,
        cache: "no-store",
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      this.#handlers.onError?.(error instanceof Error ? error.message : "the stream did not open");
      this.#scheduleReconnect();
      return;
    }

    if (response.status === 404 || response.status === 409) {
      this.#handlers.onGone?.();
      return;
    }
    if (!response.ok || response.body === null) {
      this.#handlers.onError?.(`the stream replied with ${String(response.status)}`);
      this.#scheduleReconnect();
      return;
    }

    this.#attempts = 0;
    this.#handlers.onOpen?.();

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf("\n\n");

          const frame = parseBlock(block);
          if (frame === null) continue;

          let payload: unknown;
          try {
            payload = JSON.parse(frame.data);
          } catch {
            continue;
          }

          const parsed = sgEventSchema.safeParse(payload);
          if (!parsed.success) continue;

          if (frame.id !== null) this.#lastEventId = frame.id;
          this.#handlers.onEvent(parsed.data);
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        this.#handlers.onError?.(error instanceof Error ? error.message : "the stream broke");
      }
    }

    if (!this.#isStopped() && !controller.signal.aborted) this.#scheduleReconnect();
  }

  #scheduleReconnect(): void {
    if (this.#stopped || this.#reconnectTimer !== null) return;

    const base = this.#options.baseDelayMs ?? 500;
    const maximum = this.#options.maximumDelayMs ?? 15_000;
    const jitter = this.#options.jitter ?? Math.random;

    this.#attempts += 1;
    const backoff = Math.min(maximum, base * 2 ** Math.min(this.#attempts - 1, 6));
    const delay = Math.round(backoff * (0.5 + jitter() * 0.5));

    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      void this.#open();
    }, delay);
  }
}
