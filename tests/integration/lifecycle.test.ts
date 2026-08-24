import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { pino } from "pino";
import { sql } from "drizzle-orm";
import { withProduct } from "../../apps/control-plane/src/db/client.js";
import { recoverInFlightTurns } from "../../apps/control-plane/src/turn/recovery.js";
import { readJournalSince } from "../../apps/control-plane/src/repository/journal.js";
import { findConversation, setActiveTurn } from "../../apps/control-plane/src/repository/conversations.js";
import { createTestProduct, startHarness, TEST_ORIGIN, type TestHarness } from "../helpers/server.js";
import { openSse } from "../helpers/sse.js";

describe("process lifecycle", () => {
  const started: TestHarness[] = [];

  afterEach(async () => {
    while (started.length > 0) {
      const harness = started.pop();
      if (harness !== undefined) await harness.close().catch(() => undefined);
    }
  });

  it("closes an interrupted turn with an honest escalation instead of leaving it hanging", async () => {
    const harness = await startHarness();
    started.push(harness);
    const { productId } = await createTestProduct();

    const token = await (async () => {
      const response = await fetch(`${harness.baseUrl}/v1/session`, {
        method: "POST",
        headers: {
          origin: TEST_ORIGIN,
          "content-type": "application/json",
          "x-sg-product-id": productId,
        },
        body: JSON.stringify({ productId }),
      });
      return ((await response.json()) as { sessionToken: string }).sessionToken;
    })();

    const chat = await fetch(`${harness.baseUrl}/v1/chat`, {
      method: "POST",
      headers: {
        origin: TEST_ORIGIN,
        "content-type": "application/json",
        "x-sg-product-id": productId,
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ conversationId: null, message: "hi", digest: null, url: "/" }),
    });
    const { conversationId } = (await chat.json()) as { conversationId: string };

    const strandedTurnId = randomUUID();
    await withProduct(harness.database.db, productId, (tx) =>
      setActiveTurn(tx, conversationId, strandedTurnId),
    );

    const recovered = await recoverInFlightTurns(harness.database.db, pino({ level: "silent" }));
    expect(recovered).toBeGreaterThanOrEqual(1);

    const { entries, conversation } = await withProduct(
      harness.database.db,
      productId,
      async (tx) => ({
        entries: await readJournalSince(tx, conversationId, 0),
        conversation: await findConversation(tx, conversationId),
      }),
    );

    const escalation = entries.find(
      (entry) => entry.kind === "step" && entry.step.action.type === "escalate",
    );
    expect(escalation).toBeDefined();
    if (escalation?.kind === "step") {
      expect(escalation.step.expectOutcome.satisfied).toBe(false);
      expect(escalation.step.result.status).toBe("not_executed");
      if (escalation.step.action.type === "escalate") {
        expect(escalation.step.action.reason).toBe("process_restart");
      }
    }

    expect(conversation?.resolutionState).toBe("escalated");
    expect(conversation?.activeTurnId).toBeNull();
  });

  it("closes open streams with a final event on shutdown rather than hanging the client", async () => {
    const harness = await startHarness();
    const { productId } = await createTestProduct();

    const headers = {
      origin: TEST_ORIGIN,
      "content-type": "application/json",
      "x-sg-product-id": productId,
    };
    const sessionResponse = await fetch(`${harness.baseUrl}/v1/session`, {
      method: "POST",
      headers,
      body: JSON.stringify({ productId }),
    });
    const token = ((await sessionResponse.json()) as { sessionToken: string }).sessionToken;

    const chat = await fetch(`${harness.baseUrl}/v1/chat`, {
      method: "POST",
      headers: { ...headers, authorization: `Bearer ${token}` },
      body: JSON.stringify({ conversationId: null, message: "hi", digest: null, url: "/" }),
    });
    const { conversationId } = (await chat.json()) as { conversationId: string };

    const stream = await openSse(
      `${harness.baseUrl}/v1/stream?conversationId=${conversationId}`,
      { ...headers, authorization: `Bearer ${token}` },
    );

    await stream.waitFor((frames) => frames.length >= 1);
    expect(harness.deps.streams.size).toBe(1);

    const closed = harness.deps.streams.closeAll({
      name: "turn.failed",
      payload: {
        event: "turn.failed",
        turnId: "00000000-0000-4000-8000-000000000000",
        code: "server_shutdown",
        message: "The service is restarting. Reconnect to resume.",
      },
    });
    expect(closed).toBe(1);

    await stream.closed;
    const final = stream.frames.at(-1);
    expect(final?.event).toBe("turn.failed");
    expect((final?.data as { code: string }).code).toBe("server_shutdown");

    await harness.close();
  });

  it("allocates one monotonic sequence shared by messages and steps", async () => {
    const harness = await startHarness();
    started.push(harness);
    const { productId } = await createTestProduct();

    const conversationId = await withProduct(harness.database.db, productId, async (tx) => {
      const endUser = await tx.execute<{ id: string }>(
        sql`INSERT INTO end_user (product_id, identity_tier, scopes)
            VALUES (${productId}::uuid, 'anonymous', '{}') RETURNING id`,
      );
      const endUserId = endUser.rows[0]?.id;
      if (endUserId === undefined) throw new Error("no end user");
      const created = await tx.execute<{ id: string }>(
        sql`INSERT INTO conversation (product_id, end_user_id, status, resolution_state)
            VALUES (${productId}::uuid, ${endUserId}::uuid, 'open', 'in_progress') RETURNING id`,
      );
      const id = created.rows[0]?.id;
      if (id === undefined) throw new Error("no conversation");
      return id;
    });

    const seqs = await withProduct(harness.database.db, productId, async (tx) => {
      const collected: number[] = [];
      for (let index = 0; index < 5; index += 1) {
        const result = await tx.execute<{ seq: string }>(
          sql`SELECT sg_allocate_seq(${conversationId}::uuid) AS seq`,
        );
        collected.push(Number(result.rows[0]?.seq));
      }
      return collected;
    });

    expect(seqs).toEqual([1, 2, 3, 4, 5]);
  });
});
