import { describe, expect, it, vi } from "vitest";
import { pino } from "pino";
import type { EscalationPayload } from "@superguide/contract/internal";
import {
  EscalationWebhook,
  REPLAY_WINDOW_SECONDS,
  signPayload,
  verifyPayload,
} from "./webhook.js";

const KEY = Buffer.alloc(32, 3);

function payload(): EscalationPayload {
  return {
    escalationId: "11111111-1111-4111-8111-111111111111",
    productId: "22222222-2222-4222-8222-222222222222",
    conversationId: "33333333-3333-4333-8333-333333333333",
    turnId: "44444444-4444-4444-8444-444444444444",
    reason: "expect_unsatisfied",
    detail: "the postcode did not change",
    createdAt: "2026-08-24T10:00:00.000Z",
    endUser: { id: "55555555-5555-4555-8555-555555555555", externalId: "dana", tier: "verified" },
    transcript: [{ role: "user", text: "change our postcode" }],
    trajectory: [],
    knownTrue: [],
    failurePoint: { stepSeq: 2, detail: "status 422" },
    trajectoryUrl: "https://api.trysuperguide.com/internal/conversations/x",
  };
}

describe("escalation signatures", () => {
  it("verifies a signature the sender produced", () => {
    const body = JSON.stringify(payload());
    const now = 1_800_000_000;
    const signature = signPayload(KEY, now, body);

    expect(
      verifyPayload(KEY, { signature, timestamp: String(now) }, body, now + 10),
    ).toEqual({ ok: true });
  });

  it("refuses a timestamp outside the five minute window", () => {
    const body = "{}";
    const now = 1_800_000_000;
    const signature = signPayload(KEY, now, body);

    expect(
      verifyPayload(KEY, { signature, timestamp: String(now) }, body, now + REPLAY_WINDOW_SECONDS + 1),
    ).toEqual({ ok: false, reason: "stale" });
  });

  it("refuses a tampered body, a wrong key, and a missing header", () => {
    const body = JSON.stringify(payload());
    const now = 1_800_000_000;
    const signature = signPayload(KEY, now, body);

    expect(
      verifyPayload(KEY, { signature, timestamp: String(now) }, `${body} `, now),
    ).toEqual({ ok: false, reason: "mismatch" });

    expect(
      verifyPayload(Buffer.alloc(32, 4), { signature, timestamp: String(now) }, body, now),
    ).toEqual({ ok: false, reason: "mismatch" });

    expect(verifyPayload(KEY, { signature: undefined, timestamp: String(now) }, body, now)).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(verifyPayload(KEY, { signature, timestamp: "not-a-number" }, body, now)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });
});

describe("escalation delivery", () => {
  const logger = pino({ level: "silent" });

  it("delivers on the first attempt when the receiver accepts", async () => {
    const seen: { signature: string | null; timestamp: string | null; body: string }[] = [];
    const webhook = new EscalationWebhook({
      endpoint: "https://support.example/hooks/superguide",
      signingKey: KEY,
      logger,
      now: () => 1_800_000_000_000,
      fetchImplementation: ((_url: string, init: RequestInit) => {
        const headers = init.headers as Record<string, string>;
        seen.push({
          signature: headers["x-sg-signature"] ?? null,
          timestamp: headers["x-sg-timestamp"] ?? null,
          body: typeof init.body === "string" ? init.body : "",
        });
        return Promise.resolve(new Response("{}", { status: 202 }));
      }) as unknown as typeof fetch,
    });

    const result = await webhook.deliver(payload());
    expect(result.status).toBe("delivered");
    expect(result.attempts).toHaveLength(1);

    const sent = seen[0];
    expect(sent).toBeDefined();
    if (sent === undefined) return;
    expect(
      verifyPayload(
        KEY,
        { signature: sent.signature ?? undefined, timestamp: sent.timestamp ?? undefined },
        sent.body,
        1_800_000_000,
      ),
    ).toEqual({ ok: true });
  });

  it("retries a server error with growing delays, then succeeds", async () => {
    const delays: number[] = [];
    let attempts = 0;

    const webhook = new EscalationWebhook({
      endpoint: "https://support.example/hooks/superguide",
      signingKey: KEY,
      logger,
      baseDelayMs: 100,
      sleep: (ms) => {
        delays.push(ms);
        return Promise.resolve();
      },
      fetchImplementation: () => {
        attempts += 1;
        return Promise.resolve(new Response("", { status: attempts < 3 ? 503 : 200 }));
      },
    });

    const result = await webhook.deliver(payload());
    expect(result.status).toBe("delivered");
    expect(result.attempts).toHaveLength(3);
    expect(delays).toEqual([100, 200]);
  });

  it("stops at a dead letter rather than repeating a request the receiver refused", async () => {
    const perform = vi.fn(() => Promise.resolve(new Response("", { status: 400 })));
    const webhook = new EscalationWebhook({
      endpoint: "https://support.example/hooks/superguide",
      signingKey: KEY,
      logger,
      sleep: () => Promise.resolve(),
      fetchImplementation: perform,
    });

    const result = await webhook.deliver(payload());
    expect(result.status).toBe("dead_letter");
    expect(perform).toHaveBeenCalledTimes(1);
  });

  it("records a dead letter when every attempt fails", async () => {
    const webhook = new EscalationWebhook({
      endpoint: "https://support.example/hooks/superguide",
      signingKey: KEY,
      logger,
      maxAttempts: 3,
      sleep: () => Promise.resolve(),
      fetchImplementation: () => Promise.reject(new Error("connection refused")),
    });

    const result = await webhook.deliver(payload());
    expect(result.status).toBe("dead_letter");
    expect(result.attempts).toHaveLength(3);
    expect(result.attempts.every((attempt) => attempt.error === "connection refused")).toBe(true);
  });
});
