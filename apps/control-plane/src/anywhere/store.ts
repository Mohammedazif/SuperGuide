import type pg from "pg";
import { turnEventSchema, type GrantTier, type TurnEvent } from "@superguide/contract/anywhere";
import type { AnywhereTrajectoryStepKind } from "@superguide/contract/internal";
import { concealClientText } from "../conceal-client-text.js";
import { ANYWHERE_NOTIFY_CHANNEL } from "./bus.js";

function concealEvent(event: TurnEvent): TurnEvent {
  switch (event.kind) {
    case "assistant-text":
      return {
        ...event,
        text: concealClientText(
          event.text,
          "I can't share that. Tell me what you need on this page.",
        ),
      };
    case "report":
      return {
        ...event,
        detail: concealClientText(event.detail, "the turn finished"),
      };
    case "refusal":
      return {
        ...event,
        detail: concealClientText(event.detail, "the request was refused"),
      };
    case "question":
      return {
        ...event,
        text: concealClientText(event.text, "I need one detail from you to continue."),
      };
    case "action-request":
      return {
        ...event,
        summary: concealClientText(event.summary, "act on the page"),
      };
    case "quota":
    case "turn-end":
      return event;
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export interface TurnRow {
  id: string;
  deviceId: string;
  origin: string;
  tier: GrantTier;
  status: "running" | "completed" | "failed" | "refused" | "stopped" | "needs-input";
}

export class TurnStore {
  constructor(private readonly pool: pg.Pool) {}

  async createTurn(input: {
    turnId: string;
    deviceId: string;
    origin: string;
    tier: GrantTier;
    taskText: string;
  }): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "INSERT INTO turn (id, device_id, origin, tier, task_text, status) VALUES ($1, $2, $3, $4, $5, 'running')",
        [input.turnId, input.deviceId, input.origin, input.tier, input.taskText],
      );
      await client.query(
        "INSERT INTO trajectory (turn_id, seq, kind, payload) VALUES ($1, 0, 'task-received', $2)",
        [input.turnId, JSON.stringify({ taskText: input.taskText, tier: input.tier })],
      );
      await client.query("COMMIT");
    } catch (cause) {
      await client.query("ROLLBACK");
      throw cause;
    } finally {
      client.release();
    }
  }

  async turnForDevice(turnId: string, deviceId: string): Promise<TurnRow | null> {
    const result = await this.pool.query<{
      id: string;
      device_id: string;
      origin: string;
      tier: GrantTier;
      status: TurnRow["status"];
    }>("SELECT id, device_id, origin, tier, status FROM turn WHERE id = $1 AND device_id = $2", [
      turnId,
      deviceId,
    ]);
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      id: row.id,
      deviceId: row.device_id,
      origin: row.origin,
      tier: row.tier,
      status: row.status,
    };
  }

  async appendEvent(turnId: string, event: DistributiveOmit<TurnEvent, "seq">): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT id FROM turn WHERE id = $1 FOR UPDATE", [turnId]);
      const next = await client.query<{ seq: number }>(
        "SELECT COALESCE(MAX(seq) + 1, 0) AS seq FROM turn_event WHERE turn_id = $1",
        [turnId],
      );
      const seq = next.rows[0]?.seq ?? 0;
      const payload: TurnEvent = turnEventSchema.parse(concealEvent({ ...event, seq }));
      await client.query("INSERT INTO turn_event (turn_id, seq, payload) VALUES ($1, $2, $3)", [
        turnId,
        seq,
        JSON.stringify(payload),
      ]);
      await client.query("SELECT pg_notify($1, $2)", [
        ANYWHERE_NOTIFY_CHANNEL,
        JSON.stringify({ turnId, seq }),
      ]);
      await client.query("COMMIT");
      return seq;
    } catch (cause) {
      await client.query("ROLLBACK");
      throw cause;
    } finally {
      client.release();
    }
  }

  async eventsAfter(turnId: string, after: number): Promise<TurnEvent[]> {
    const result = await this.pool.query<{ payload: unknown }>(
      "SELECT payload FROM turn_event WHERE turn_id = $1 AND seq > $2 ORDER BY seq",
      [turnId, after],
    );
    return result.rows.map((row) => concealEvent(turnEventSchema.parse(row.payload)));
  }

  async finishTurn(
    turnId: string,
    status: Exclude<TurnRow["status"], "running">,
    inSameTransaction?: (client: pg.PoolClient) => Promise<void>,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const updated = await client.query(
        "UPDATE turn SET status = $2, ended_at = now() WHERE id = $1 AND status = 'running'",
        [turnId, status],
      );
      if (updated.rowCount === 1 && inSameTransaction !== undefined) {
        await inSameTransaction(client);
      }
      await client.query("COMMIT");
    } catch (cause) {
      await client.query("ROLLBACK");
      throw cause;
    } finally {
      client.release();
    }
  }

  async appendTrajectory(
    turnId: string,
    kind: AnywhereTrajectoryStepKind,
    payload: unknown,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT id FROM turn WHERE id = $1 FOR UPDATE", [turnId]);
      await client.query(
        "INSERT INTO trajectory (turn_id, seq, kind, payload) SELECT $1, COALESCE(MAX(seq) + 1, 0), $2, $3 FROM trajectory WHERE turn_id = $1",
        [turnId, kind, JSON.stringify(payload ?? null)],
      );
      await client.query("COMMIT");
    } catch (cause) {
      await client.query("ROLLBACK");
      throw cause;
    } finally {
      client.release();
    }
  }
}
