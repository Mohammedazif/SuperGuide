import { createHmac, timingSafeEqual } from "node:crypto";
import type { EscalationPayload } from "@superguide/contract/internal";
import type { AppLogger } from "../logging.js";

export const SIGNATURE_HEADER = "x-sg-signature";
export const TIMESTAMP_HEADER = "x-sg-timestamp";
export const REPLAY_WINDOW_SECONDS = 300;

export function signPayload(key: Buffer, timestampSeconds: number, body: string): string {
  return createHmac("sha256", key)
    .update(`${String(timestampSeconds)}.${body}`)
    .digest("hex");
}

export type SignatureCheck =
  | { ok: true }
  | { ok: false; reason: "malformed" | "stale" | "mismatch" };

// Receiver verify matches signPayload; five-minute replay window is a tested property.
export function verifyPayload(
  key: Buffer,
  headers: { signature: string | undefined; timestamp: string | undefined },
  body: string,
  nowSeconds: number,
): SignatureCheck {
  if (headers.signature === undefined || headers.timestamp === undefined) {
    return { ok: false, reason: "malformed" };
  }
  if (!/^\d+$/.test(headers.timestamp)) return { ok: false, reason: "malformed" };

  const timestamp = Number(headers.timestamp);
  if (Math.abs(nowSeconds - timestamp) > REPLAY_WINDOW_SECONDS) return { ok: false, reason: "stale" };

  const expected = Buffer.from(signPayload(key, timestamp, body), "utf8");
  const provided = Buffer.from(headers.signature, "utf8");
  if (expected.length !== provided.length) return { ok: false, reason: "mismatch" };
  return timingSafeEqual(expected, provided) ? { ok: true } : { ok: false, reason: "mismatch" };
}

export interface DeliveryAttempt {
  attempt: number;
  status: number | null;
  error: string | null;
}

export type DeliveryResult =
  | { status: "delivered"; attempts: DeliveryAttempt[] }
  | { status: "dead_letter"; attempts: DeliveryAttempt[] };

export interface WebhookOptions {
  endpoint: string;
  signingKey: Buffer;
  logger: AppLogger;
  maxAttempts?: number;
  baseDelayMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  fetchImplementation?: typeof fetch;
}

export class EscalationWebhook {
  readonly #options: WebhookOptions;

  constructor(options: WebhookOptions) {
    this.#options = options;
  }

  async deliver(payload: EscalationPayload): Promise<DeliveryResult> {
    const body = JSON.stringify(payload);
    const maxAttempts = this.#options.maxAttempts ?? 5;
    const baseDelay = this.#options.baseDelayMs ?? 500;
    const now = this.#options.now ?? (() => Date.now());
    const sleep =
      this.#options.sleep ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const perform = this.#options.fetchImplementation ?? fetch;

    const attempts: DeliveryAttempt[] = [];

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const timestamp = Math.floor(now() / 1000);
      const signature = signPayload(this.#options.signingKey, timestamp, body);

      try {
        const response = await perform(this.#options.endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [SIGNATURE_HEADER]: signature,
            [TIMESTAMP_HEADER]: String(timestamp),
          },
          body,
        });

        attempts.push({ attempt, status: response.status, error: null });
        if (response.ok) return { status: "delivered", attempts };

        // 4xx except 429 is not retried; repeating will not make it succeed.
        if (response.status >= 400 && response.status < 500 && response.status !== 429) {
          return { status: "dead_letter", attempts };
        }
      } catch (error) {
        attempts.push({
          attempt,
          status: null,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      if (attempt < maxAttempts) await sleep(baseDelay * 2 ** (attempt - 1));
    }

    this.#options.logger.error(
      { escalationId: payload.escalationId, attempts },
      "an escalation could not be delivered and became a dead letter",
    );
    return { status: "dead_letter", attempts };
  }
}
