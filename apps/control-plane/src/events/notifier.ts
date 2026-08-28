import pg from "pg";
import { z } from "zod";
import type { AppLogger } from "../logging.js";

export const NOTIFY_CHANNEL = "sg_events";

const notificationSchema = z.object({ c: z.uuid(), s: z.int().nonnegative() });

export interface DurableNotification {
  conversationId: string;
  seq: number;
}

export type NotificationHandler = (notification: DurableNotification) => void;

export interface DurableNotifier {
  subscribe(conversationId: string, handler: NotificationHandler): () => void;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export class PostgresNotifier implements DurableNotifier {
  readonly #connectionString: string;
  readonly #logger: AppLogger;
  readonly #handlers = new Map<string, Set<NotificationHandler>>();
  #client: pg.Client | null = null;
  #stopping = false;
  #reconnectTimer: NodeJS.Timeout | null = null;

  constructor(connectionString: string, logger: AppLogger) {
    this.#connectionString = connectionString;
    this.#logger = logger;
  }

  subscribe(conversationId: string, handler: NotificationHandler): () => void {
    const existing = this.#handlers.get(conversationId);
    if (existing === undefined) {
      this.#handlers.set(conversationId, new Set([handler]));
    } else {
      existing.add(handler);
    }

    return () => {
      const handlers = this.#handlers.get(conversationId);
      if (handlers === undefined) return;
      handlers.delete(handler);
      if (handlers.size === 0) this.#handlers.delete(conversationId);
    };
  }

  async start(): Promise<void> {
    this.#stopping = false;
    await this.#connect();
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    if (this.#reconnectTimer !== null) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    const client = this.#client;
    this.#client = null;
    if (client !== null) {
      try {
        await client.end();
      } catch (error) {
        this.#logger.warn({ err: error }, "notifier client did not close cleanly");
      }
    }
    this.#handlers.clear();
  }

  async #connect(): Promise<void> {
    const client = new pg.Client({ connectionString: this.#connectionString });

    client.on("notification", (raw) => {
      if (raw.channel !== NOTIFY_CHANNEL || raw.payload === undefined) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.payload);
      } catch (error) {
        this.#logger.warn({ err: error }, "notification payload was not valid json");
        return;
      }
      const notification = notificationSchema.safeParse(parsed);
      if (!notification.success) {
        this.#logger.warn({ payload: raw.payload }, "notification payload failed validation");
        return;
      }
      this.#dispatch({
        conversationId: notification.data.c,
        seq: notification.data.s,
      });
    });

    client.on("error", (error) => {
      this.#logger.warn({ err: error }, "notifier connection error");
      this.#scheduleReconnect();
    });

    await client.connect();
    await client.query(`LISTEN ${NOTIFY_CHANNEL}`);
    this.#client = client;
  }

  #dispatch(notification: DurableNotification): void {
    const handlers = this.#handlers.get(notification.conversationId);
    if (handlers === undefined) return;
    for (const handler of handlers) {
      try {
        handler(notification);
      } catch (error) {
        this.#logger.warn({ err: error }, "notification handler threw");
      }
    }
  }

  #scheduleReconnect(): void {
    if (this.#stopping || this.#reconnectTimer !== null) return;
    this.#client = null;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      void this.#connect().catch((error: unknown) => {
        this.#logger.error({ err: error }, "notifier reconnect failed");
        this.#scheduleReconnect();
      });
    }, 500);
    this.#reconnectTimer.unref();
  }
}
