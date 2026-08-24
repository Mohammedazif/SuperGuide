import { randomUUID } from "node:crypto";
import type { EscalationPayload } from "@superguide/contract/internal";
import { withProduct, type Database } from "../db/client.js";
import { findProduct } from "../repository/products.js";
import { findConversation } from "../repository/conversations.js";
import { readJournalSince } from "../repository/journal.js";
import type { AppLogger } from "../logging.js";
import type { EscalationContext, EscalationSink } from "../turn/loop.js";
import { EscalationWebhook } from "./webhook.js";

export class NoEscalationSink implements EscalationSink {
  publish(): Promise<void> {
    return Promise.resolve();
  }
}

export interface WebhookEscalationSinkOptions {
  db: Database;
  logger: AppLogger;
  signingKey: Buffer;
  publicOrigin: string;
  now?: () => Date;
  fetchImplementation?: typeof fetch;
}

export class WebhookEscalationSink implements EscalationSink {
  readonly #options: WebhookEscalationSinkOptions;

  constructor(options: WebhookEscalationSinkOptions) {
    this.#options = options;
  }

  async publish(context: EscalationContext): Promise<void> {
    const assembled = await withProduct(this.#options.db, context.productId, async (tx) => {
      const product = await findProduct(tx, context.productId);
      if (product === null) return null;
      const conversation = await findConversation(tx, context.conversationId);
      if (conversation === null) return null;
      const entries = await readJournalSince(tx, context.conversationId, 0, 500);
      return { product, conversation, entries };
    });

    if (assembled === null) {
      this.#options.logger.warn(
        { conversationId: context.conversationId },
        "an escalation had nothing to hand over",
      );
      return;
    }

    const endpoint = assembled.product.escalationWebhookUrl;
    const steps = assembled.entries.flatMap((entry) => (entry.kind === "step" ? [entry.step] : []));
    const transcript = assembled.entries.flatMap((entry) =>
      entry.kind === "message" ? [{ role: entry.message.role, text: entry.message.content.text }] : [],
    );
    const failure = steps.find((step) => !step.expectOutcome.satisfied);

    const payload: EscalationPayload = {
      escalationId: randomUUID(),
      productId: context.productId,
      conversationId: context.conversationId,
      turnId: context.turnId,
      reason: context.reason,
      detail: context.detail,
      createdAt: (this.#options.now ?? (() => new Date()))().toISOString(),
      endUser: {
        id: context.identity.endUserId,
        externalId: context.identity.externalId,
        tier: context.identity.tier,
      },
      transcript,
      trajectory: steps,
      // Only what a check actually confirmed is reported as known.
      knownTrue: steps
        .filter((step) => step.expectOutcome.satisfied)
        .map((step) => `${step.action.intent} — ${step.expectOutcome.detail}`),
      failurePoint:
        failure === undefined ? null : { stepSeq: failure.seq, detail: failure.expectOutcome.detail },
      trajectoryUrl: `${this.#options.publicOrigin}/internal/conversations/${context.conversationId}?productId=${context.productId}`,
    };

    if (endpoint === null) {
      this.#options.logger.warn(
        { productId: context.productId, escalationId: payload.escalationId, reason: context.reason },
        "this product has no escalation endpoint, so the handover was only recorded",
      );
      return;
    }

    const webhook = new EscalationWebhook({
      endpoint,
      signingKey: this.#options.signingKey,
      logger: this.#options.logger,
      ...(this.#options.fetchImplementation === undefined
        ? {}
        : { fetchImplementation: this.#options.fetchImplementation }),
    });

    const result = await webhook.deliver(payload);
    if (result.status === "dead_letter") {
      // The dead letter lives in the trajectory rather than in a twelfth table: the run it
      // belongs to is exactly where a support lead will look for it.
      this.#options.logger.error(
        { escalationId: payload.escalationId, attempts: result.attempts },
        "escalation dead letter",
      );
    }
  }
}
