import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import Fastify, { type FastifyInstance, type RawServerDefault } from "fastify";
import {
  chatRequestSchema,
  confirmRequestSchema,
  createSessionRequestSchema,
  identifyRequestSchema,
  toolResultRequestSchema,
  type ConversationSummary,
  type Identity,
  type ProductConfig,
  type SessionResponse,
} from "@superguide/contract/public";
import type { Product } from "@superguide/contract/internal";
import { withProduct, type Database } from "./db/client.js";
import { ApiFailure } from "./errors.js";
import type { AppLogger } from "./logging.js";
import type { Environment } from "./env.js";
import { checkOrigin } from "./auth/origin.js";
import {
  signSessionToken,
  verifySessionToken,
  type SessionClaims,
} from "./auth/session-token.js";
import type { IdentityVerifier } from "./auth/identity-verifier.js";
import { findProduct } from "./repository/products.js";
import { createAnonymousEndUser, upsertIdentifiedEndUser } from "./repository/end-users.js";
import {
  createConversation,
  findConversation,
  listConversations,
  setActiveTurn,
} from "./repository/conversations.js";
import { appendMessage, readJournalSince } from "./repository/journal.js";
import { ConversationStream, type StreamRegistry } from "./events/stream.js";
import type { DurableNotifier } from "./events/notifier.js";
import type { EphemeralBus } from "./events/ephemeral.js";
import type { PendingCalls } from "./turn/pending-calls.js";
import type { ConfirmationRegistry } from "./turn/confirmations.js";
import type { TurnRunner } from "./turn/types.js";

export interface Clock {
  now(): Date;
}

export interface ServerDependencies {
  env: Environment;
  logger: AppLogger;
  db: Database;
  notifier: DurableNotifier;
  ephemeral: EphemeralBus;
  pendingCalls: PendingCalls;
  confirmations: ConfirmationRegistry;
  turnRunner: TurnRunner;
  identityVerifier: IdentityVerifier;
  streams: StreamRegistry;
  clock: Clock;
  sessionTtlSeconds?: number;
  heartbeatIntervalMs?: number;
}

declare module "fastify" {
  interface FastifyRequest {
    sgProduct?: Product;
    sgOrigin?: string;
    sgSession?: SessionClaims;
  }
}

const SESSION_TTL_SECONDS = 30 * 60;
const CORS_HEADERS = "content-type, authorization, x-sg-product-id, last-event-id";

interface RequestLike {
  headers: Record<string, string | string[] | undefined>;
  query: unknown;
}

interface SessionCarrier extends RequestLike {
  sgProduct?: Product | undefined;
  sgSession?: SessionClaims | undefined;
}

function productIdFrom(request: RequestLike): string | null {
  const header = request.headers["x-sg-product-id"];
  if (typeof header === "string" && header.length > 0) return header;
  const query = request.query;
  if (typeof query === "object" && query !== null && "productId" in query) {
    const value = (query as { productId?: unknown }).productId;
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function bearerFrom(request: RequestLike): string | null {
  const header = request.headers.authorization;
  if (typeof header === "string" && header.startsWith("Bearer ")) return header.slice(7);
  const query = request.query;
  if (typeof query === "object" && query !== null && "token" in query) {
    const value = (query as { token?: unknown }).token;
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

export type AppServer = FastifyInstance<RawServerDefault, IncomingMessage, ServerResponse, AppLogger>;

export function buildServer(deps: ServerDependencies): AppServer {
  const app = Fastify({
    loggerInstance: deps.logger,
    genReqId: () => randomUUID(),
    bodyLimit: 1_048_576,
  });

  const sessionKey = Buffer.from(deps.env.SG_SESSION_SIGNING_KEY, "base64");
  const sessionTtl = deps.sessionTtlSeconds ?? SESSION_TTL_SECONDS;

  const loadProduct = async (productId: string): Promise<Product> => {
    const product = await withProduct(deps.db, productId, (tx) => findProduct(tx, productId));
    if (product === null) throw new ApiFailure("product_unknown");
    return product;
  };

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiFailure) {
      request.log.info({ code: error.code, detail: error.detail }, "request rejected");
      void reply.status(error.httpStatus).send(error.toBody());
      return;
    }
    request.log.error({ err: error }, "unhandled request error");
    void reply
      .status(500)
      .send({ error: { code: "internal_error", message: "Internal error." } });
  });

  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-sg-request-id", request.id);
    if (!request.url.startsWith("/v1")) return;

    const productId = productIdFrom(request);
    if (productId === null) throw new ApiFailure("payload_invalid", "x-sg-product-id is required");

    const product = await loadProduct(productId);
    request.sgProduct = product;

    const rawOrigin = request.headers.origin;
    const decision = checkOrigin(
      typeof rawOrigin === "string" ? rawOrigin : undefined,
      product.originAllowlist,
    );
    if (!decision.allowed) throw new ApiFailure("origin_not_allowed");
    request.sgOrigin = decision.origin;

    reply.header("access-control-allow-origin", decision.origin);
    reply.header("vary", "origin");
    reply.header("access-control-allow-headers", CORS_HEADERS);
    reply.header("access-control-allow-methods", "GET, POST, OPTIONS");
    reply.header("access-control-expose-headers", "x-sg-request-id");
    reply.header("access-control-max-age", "600");

    if (request.method === "OPTIONS") {
      await reply.status(204).send();
    }
  });

  const requireSession = (request: SessionCarrier): SessionClaims => {
    const token = bearerFrom(request);
    if (token === null) throw new ApiFailure("session_invalid");

    const nowSeconds = Math.floor(deps.clock.now().getTime() / 1000);
    const verification = verifySessionToken(sessionKey, token, nowSeconds);
    if (!verification.ok) {
      throw new ApiFailure(verification.reason === "expired" ? "session_expired" : "session_invalid");
    }

    const product = request.sgProduct;
    if (product === undefined || verification.claims.productId !== product.id) {
      throw new ApiFailure("session_invalid");
    }
    request.sgSession = verification.claims;
    return verification.claims;
  };

  const identityFrom = (claims: SessionClaims): Identity => ({
    tier: claims.tier,
    endUserId: claims.endUserId,
    externalId: claims.externalId,
    scopes: claims.scopes,
    claims: {},
  });

  const issueSession = (claims: Omit<SessionClaims, "issuedAt" | "expiresAt">): SessionResponse => {
    const issuedAt = Math.floor(deps.clock.now().getTime() / 1000);
    const expiresAt = issuedAt + sessionTtl;
    const full: SessionClaims = { ...claims, issuedAt, expiresAt };
    return {
      sessionToken: signSessionToken(sessionKey, full),
      expiresAt: new Date(expiresAt * 1000).toISOString(),
      tier: full.tier,
      scopes: full.scopes,
    };
  };

  app.get("/health", () => ({ status: "ok" }));

  app.get("/ready", async (_request, reply) => {
    try {
      await deps.db.execute("SELECT 1");
      return { status: "ready" };
    } catch (error) {
      deps.logger.error({ err: error }, "readiness probe failed");
      return reply.status(503).send({ status: "unavailable" });
    }
  });

  app.post("/v1/session", async (request, reply) => {
    const product = request.sgProduct;
    if (product === undefined) throw new ApiFailure("product_unknown");

    const body = createSessionRequestSchema.safeParse(request.body);
    if (!body.success) throw new ApiFailure("payload_invalid");
    if (body.data.productId !== product.id) throw new ApiFailure("payload_invalid");

    const endUser = await withProduct(deps.db, product.id, (tx) =>
      createAnonymousEndUser(tx, product.id),
    );

    return reply.status(200).send(
      issueSession({
        productId: product.id,
        endUserId: endUser.id,
        tier: "anonymous",
        scopes: [],
        externalId: null,
      }),
    );
  });

  app.post("/v1/identify", async (request, reply) => {
    const product = request.sgProduct;
    if (product === undefined) throw new ApiFailure("product_unknown");
    requireSession(request);

    const body = identifyRequestSchema.safeParse(request.body);
    if (!body.success) throw new ApiFailure("payload_invalid");

    const verification = await deps.identityVerifier.verify(product, body.data.token);
    if (!verification.ok) {
      request.log.info({ reason: verification.reason }, "identity rejected");
      throw new ApiFailure("identity_rejected");
    }

    const endUser = await withProduct(deps.db, product.id, (tx) =>
      upsertIdentifiedEndUser(
        tx,
        product.id,
        verification.identity.externalId,
        verification.identity.tier,
        verification.identity.scopes,
      ),
    );

    return reply.status(200).send(
      issueSession({
        productId: product.id,
        endUserId: endUser.id,
        tier: verification.identity.tier,
        scopes: verification.identity.scopes,
        externalId: verification.identity.externalId,
      }),
    );
  });

  app.get<{ Params: { productId: string } }>(
    "/v1/products/:productId/config",
    async (request, reply) => {
      const product = request.sgProduct;
      if (product === undefined || product.id !== request.params.productId) {
        throw new ApiFailure("product_unknown");
      }

      const config: ProductConfig = {
        productId: product.id,
        name: product.name,
        groundedActionsEnabled:
          deps.env.SG_ENABLE_GROUNDED_ACTIONS && product.groundedActionsEnabled,
        stepBudget: deps.env.SG_STEP_BUDGET,
        routes: product.routeRegistry.routes,
        redactionAllowlist: product.redactionAllowlist.fieldNames,
      };
      return reply.status(200).send(config);
    },
  );

  app.post("/v1/chat", async (request, reply) => {
    const product = request.sgProduct;
    if (product === undefined) throw new ApiFailure("product_unknown");
    const claims = requireSession(request);

    const body = chatRequestSchema.safeParse(request.body);
    if (!body.success) throw new ApiFailure("payload_invalid");

    const turnId = randomUUID();

    const conversationId = await withProduct(deps.db, product.id, async (tx) => {
      let id = body.data.conversationId;
      if (id === null) {
        const created = await createConversation(tx, product.id, claims.endUserId);
        id = created.id;
      } else {
        const existing = await findConversation(tx, id);
        if (existing === null) throw new ApiFailure("conversation_unknown");
        if (existing.endUserId !== claims.endUserId) throw new ApiFailure("conversation_unknown");
      }

      await appendMessage(tx, {
        conversationId: id,
        productId: product.id,
        role: "user",
        text: body.data.message,
      });
      await setActiveTurn(tx, id, turnId);
      return id;
    });

    deps.turnRunner.start({
      productId: product.id,
      conversationId,
      turnId,
      identity: identityFrom(claims),
      userMessage: body.data.message,
      digest: body.data.digest,
      url: body.data.url,
      requestId: request.id,
    });

    return reply.status(202).send({ turnId, conversationId });
  });

  app.get("/v1/stream", async (request, reply) => {
    const product = request.sgProduct;
    if (product === undefined) throw new ApiFailure("product_unknown");
    const claims = requireSession(request);

    const query = request.query as { conversationId?: unknown };
    const conversationId = typeof query.conversationId === "string" ? query.conversationId : null;
    if (conversationId === null) throw new ApiFailure("payload_invalid");

    const conversation = await withProduct(deps.db, product.id, (tx) =>
      findConversation(tx, conversationId),
    );
    if (conversation === null || conversation.endUserId !== claims.endUserId) {
      throw new ApiFailure("conversation_unknown");
    }

    const lastEventHeader = request.headers["last-event-id"];
    const lastEventId =
      typeof lastEventHeader === "string" && /^\d+$/.test(lastEventHeader)
        ? Number(lastEventHeader)
        : 0;

    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      "access-control-allow-origin": request.sgOrigin ?? "",
      vary: "origin",
    });

    const stream = new ConversationStream({
      db: deps.db,
      notifier: deps.notifier,
      ephemeral: deps.ephemeral,
      logger: deps.logger,
      productId: product.id,
      conversationId,
      lastEventId,
      sink: {
        write: (chunk) => {
          if (!reply.raw.writableEnded) reply.raw.write(chunk);
        },
        end: () => {
          if (!reply.raw.writableEnded) reply.raw.end();
        },
      },
      ...(deps.heartbeatIntervalMs === undefined
        ? {}
        : { heartbeatIntervalMs: deps.heartbeatIntervalMs }),
    });

    const detach = deps.streams.add(stream);
    request.raw.on("close", () => {
      detach();
      stream.close();
    });

    await stream.open();
    return reply;
  });

  app.post("/v1/tool-result", async (request, reply) => {
    const product = request.sgProduct;
    if (product === undefined) throw new ApiFailure("product_unknown");
    const claims = requireSession(request);

    const body = toolResultRequestSchema.safeParse(request.body);
    if (!body.success) throw new ApiFailure("payload_invalid");

    const conversation = await withProduct(deps.db, product.id, (tx) =>
      findConversation(tx, body.data.conversationId),
    );
    if (conversation === null || conversation.endUserId !== claims.endUserId) {
      throw new ApiFailure("conversation_unknown");
    }

    const outcome = deps.pendingCalls.deliver(
      body.data.conversationId,
      body.data.toolCallId,
      body.data.result,
    );

    switch (outcome) {
      case "accepted":
        return reply.status(202).send({ status: "accepted" });
      case "duplicate":
        return reply.status(200).send({ status: "duplicate" });
      case "unknown_call":
        return reply.status(200).send({ status: "unknown_call" });
      default: {
        const exhaustive: never = outcome;
        throw new Error(`unhandled delivery outcome: ${String(exhaustive)}`);
      }
    }
  });

  app.post("/v1/confirm", async (request, reply) => {
    const product = request.sgProduct;
    if (product === undefined) throw new ApiFailure("product_unknown");
    const claims = requireSession(request);

    const body = confirmRequestSchema.safeParse(request.body);
    if (!body.success) throw new ApiFailure("payload_invalid");

    const conversation = await withProduct(deps.db, product.id, (tx) =>
      findConversation(tx, body.data.conversationId),
    );
    if (conversation === null || conversation.endUserId !== claims.endUserId) {
      throw new ApiFailure("conversation_unknown");
    }

    const outcome = deps.confirmations.decide(
      body.data.conversationId,
      body.data.toolCallId,
      body.data.paramsHash,
      body.data.decision,
    );

    switch (outcome.status) {
      case "accepted":
        return reply.status(202).send({ status: "accepted" });
      case "params_mismatch":
        throw new ApiFailure("params_hash_mismatch");
      case "unknown_call":
        throw new ApiFailure("tool_call_unknown");
      default: {
        const exhaustive: never = outcome;
        throw new Error(`unhandled confirmation outcome: ${JSON.stringify(exhaustive)}`);
      }
    }
  });

  app.post<{ Params: { turnId: string } }>("/v1/turns/:turnId/cancel", async (request, reply) => {
    if (request.sgProduct === undefined) throw new ApiFailure("product_unknown");
    requireSession(request);

    const cancelled = deps.turnRunner.cancel(request.params.turnId);
    if (!cancelled) throw new ApiFailure("turn_unknown");
    return reply.status(202).send({ status: "cancelling" });
  });

  app.get("/v1/conversations", async (request, reply) => {
    const product = request.sgProduct;
    if (product === undefined) throw new ApiFailure("product_unknown");
    const claims = requireSession(request);

    const conversations = await withProduct(deps.db, product.id, async (tx) => {
      const rows = await listConversations(tx, product.id, claims.endUserId);
      const summaries: ConversationSummary[] = [];
      for (const row of rows) {
        const journal = await readJournalSince(tx, row.id, 0, 200);
        const messages = journal.filter((entry) => entry.kind === "message");
        const latest = messages.at(-1);
        summaries.push({
          id: row.id,
          status: row.status,
          resolutionState: row.resolutionState,
          createdAt: row.createdAt.toISOString(),
          closedAt: row.closedAt === null ? null : row.closedAt.toISOString(),
          lastMessagePreview:
            latest === undefined ? "" : latest.message.content.text.slice(0, 160),
        });
      }
      return summaries;
    });

    return reply.status(200).send({ conversations });
  });

  app.addHook("onRequest", (request, _reply, done) => {
    if (!request.url.startsWith("/internal")) {
      done();
      return;
    }
    if (bearerFrom(request) !== null) {
      done(new ApiFailure("session_invalid", "widget sessions cannot reach console routes"));
      return;
    }
    done();
  });

  app.setNotFoundHandler((_request, reply) => {
    void reply.status(404).send({ error: { code: "not_found", message: "Not found." } });
  });

  return app;
}
