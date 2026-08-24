import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestProduct,
  journalWriter,
  startHarness,
  TEST_ORIGIN,
  type TestHarness,
} from "../helpers/server.js";
import { openSse } from "../helpers/sse.js";

describe("turn transport", () => {
  let harness: TestHarness;
  let productId: string;

  beforeAll(async () => {
    harness = await startHarness({
      execute: () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve({
              resolutionState: "resolved" as const,
              summary: "finished",
              closeConversation: true,
            });
          }, 50);
        }),
    });
    ({ productId } = await createTestProduct());
  });

  afterAll(async () => {
    await harness.close();
  });

  const headers = (token?: string): Record<string, string> => ({
    origin: TEST_ORIGIN,
    "content-type": "application/json",
    "x-sg-product-id": productId,
    ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
  });

  async function openSession(): Promise<string> {
    const response = await fetch(`${harness.baseUrl}/v1/session`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ productId }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { sessionToken: string; tier: string };
    expect(body.tier).toBe("anonymous");
    return body.sessionToken;
  }

  it("accepts a chat with 202 and never blocks on the turn", async () => {
    const token = await openSession();
    const started = Date.now();
    const response = await fetch(`${harness.baseUrl}/v1/chat`, {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify({
        conversationId: null,
        message: "my invoice address is wrong",
        digest: null,
        url: `${TEST_ORIGIN}/settings`,
      }),
    });

    expect(response.status).toBe(202);
    const body = (await response.json()) as { turnId: string; conversationId: string };
    expect(body.turnId).toMatch(/^[0-9a-f-]{36}$/);
    expect(Date.now() - started).toBeLessThan(50);
  });

  it("streams durable events, resumes from Last-Event-ID with no gap and no duplicate", async () => {
    const token = await openSession();
    const chat = await fetch(`${harness.baseUrl}/v1/chat`, {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify({
        conversationId: null,
        message: "hello",
        digest: null,
        url: `${TEST_ORIGIN}/`,
      }),
    });
    const { conversationId, turnId } = (await chat.json()) as {
      conversationId: string;
      turnId: string;
    };

    const first = await openSse(
      `${harness.baseUrl}/v1/stream?conversationId=${conversationId}&productId=${productId}`,
      headers(token),
    );

    const writer = journalWriter(harness);
    await writer.step(productId, conversationId, turnId);
    await writer.message(productId, conversationId, "first assistant message");

    await first.waitFor((frames) => frames.filter((f) => f.id !== null).length >= 3);

    const beforeCut = first.frames.filter((f) => f.id !== null).map((f) => f.id);
    const lastSeen = beforeCut.at(-1);
    expect(lastSeen).toBeGreaterThan(0);

    first.close();
    await first.closed;

    await writer.step(productId, conversationId, turnId);
    await writer.message(productId, conversationId, "second assistant message");
    await writer.step(productId, conversationId, turnId);

    const second = await openSse(
      `${harness.baseUrl}/v1/stream?conversationId=${conversationId}&productId=${productId}`,
      { ...headers(token), "last-event-id": String(lastSeen) },
    );
    await second.waitFor((frames) => frames.filter((f) => f.id !== null).length >= 3);

    const afterResume = second.frames
      .filter((frame) => frame.id !== null)
      .map((frame) => frame.id as number);

    second.close();
    await second.closed;

    expect(afterResume[0]).toBe((lastSeen as number) + 1);

    for (let index = 1; index < afterResume.length; index += 1) {
      expect(afterResume[index]).toBe((afterResume[index - 1] as number) + 1);
    }

    const overlap = afterResume.filter((id) => beforeCut.includes(id));
    expect(overlap).toEqual([]);

    const everySeq = [...(beforeCut as number[]), ...afterResume];
    expect(everySeq).toEqual([...new Set(everySeq)]);
    expect(everySeq).toEqual([...everySeq].sort((a, b) => a - b));
  });

  it("delivers a tool result once and reports a repeat as a duplicate", async () => {
    const token = await openSession();
    const chat = await fetch(`${harness.baseUrl}/v1/chat`, {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify({
        conversationId: null,
        message: "hello",
        digest: null,
        url: `${TEST_ORIGIN}/`,
      }),
    });
    const { conversationId } = (await chat.json()) as { conversationId: string };

    const toolCallId = randomUUID();
    const settled = harness.deps.pendingCalls.register(toolCallId, conversationId, 5000, () => ({
      status: "failed" as const,
      error: { code: "TIMEOUT" as const, message: "no result" },
      digest: null,
      url: "",
    }));

    const body = JSON.stringify({
      conversationId,
      toolCallId,
      result: { status: "ok", data: { done: true }, digest: null, url: `${TEST_ORIGIN}/` },
    });

    const firstDelivery = await fetch(`${harness.baseUrl}/v1/tool-result`, {
      method: "POST",
      headers: headers(token),
      body,
    });
    expect(firstDelivery.status).toBe(202);
    expect(await firstDelivery.json()).toEqual({ status: "accepted" });

    const resolved = await settled;
    expect(resolved.status).toBe("ok");

    const secondDelivery = await fetch(`${harness.baseUrl}/v1/tool-result`, {
      method: "POST",
      headers: headers(token),
      body,
    });
    expect(secondDelivery.status).toBe(200);
    expect(await secondDelivery.json()).toEqual({ status: "duplicate" });
  });

  it("rejects an origin outside the allowlist, including on the stream", async () => {
    const token = await openSession();

    const chat = await fetch(`${harness.baseUrl}/v1/chat`, {
      method: "POST",
      headers: { ...headers(token), origin: "https://evil.example" },
      body: JSON.stringify({ conversationId: null, message: "x", digest: null, url: "/" }),
    });
    expect(chat.status).toBe(403);

    const stream = await fetch(`${harness.baseUrl}/v1/stream?conversationId=${randomUUID()}`, {
      headers: { ...headers(token), origin: "https://evil.example" },
    });
    expect(stream.status).toBe(403);
  });
});
