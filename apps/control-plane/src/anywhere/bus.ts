import pg from "pg";
import { z } from "zod";
import { pgConnectOptions } from "../db/connect.js";

export const ANYWHERE_NOTIFY_CHANNEL = "sga_events";

const notificationSchema = z.strictObject({
  turnId: z.uuid(),
  seq: z.number().int().min(0),
});

export class EventBus {
  private readonly subscribers = new Map<string, Set<(seq: number) => void>>();

  private constructor(private readonly client: pg.Client) {}

  static async start(connectionString: string): Promise<EventBus> {
    const client = new pg.Client(pgConnectOptions(connectionString));
    await client.connect();
    const bus = new EventBus(client);
    client.on("notification", (message) => {
      if (message.channel !== ANYWHERE_NOTIFY_CHANNEL || message.payload === undefined) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(message.payload);
      } catch {
        return;
      }
      const notification = notificationSchema.safeParse(parsed);
      if (!notification.success) return;
      const callbacks = bus.subscribers.get(notification.data.turnId);
      if (callbacks === undefined) return;
      for (const callback of callbacks) callback(notification.data.seq);
    });
    await client.query(`LISTEN ${ANYWHERE_NOTIFY_CHANNEL}`);
    return bus;
  }

  subscribe(turnId: string, callback: (seq: number) => void): () => void {
    const callbacks = this.subscribers.get(turnId) ?? new Set();
    callbacks.add(callback);
    this.subscribers.set(turnId, callbacks);
    return () => {
      callbacks.delete(callback);
      if (callbacks.size === 0) this.subscribers.delete(turnId);
    };
  }

  async stop(): Promise<void> {
    await this.client.end();
  }
}
