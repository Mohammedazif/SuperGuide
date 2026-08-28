import { randomUUID } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import { matchAdapter } from "@superguide/adapters";
import {
  actionResultRequestSchema,
  anywhereConfirmRequestSchema,
  deviceRegisterRequestSchema,
  taskRequestSchema,
  type AdapterSet,
  type AnywhereErrorCode,
  type Quota,
} from "@superguide/contract/anywhere";
import type { DeviceTokenClaims } from "@superguide/contract/internal";
import type { Environment } from "../env.js";
import type { AppServer } from "../server.js";
import { signDeviceToken, verifyDeviceToken } from "../auth/device-token.js";
import type { EventBus } from "./bus.js";
import { QuotaService, resetsAtOf } from "./quota.js";
import { TurnStore } from "./store.js";
import type { TurnAgentStarter } from "./types.js";

export interface AnywhereRouteDeps {
  env: Environment;
  pool: pg.Pool;
  bus: EventBus;
  agent: TurnAgentStarter | null;
  adapterSet: AdapterSet;
}

const DEVICE_REGISTRATIONS_PER_IP_PER_DAY = 50;
const TOKEN_HEADER = "x-sga-device-token";
const EXTENSION_ORIGIN_HEADER = "x-sga-extension-origin";

function sendError(
  reply: FastifyReply,
  status: number,
  code: AnywhereErrorCode,
  message: string,
  resetsAt?: string,
): void {
  void reply.status(status).send({
    error: resetsAt === undefined ? { code, message } : { code, message, resetsAt },
  });
}

function anywherePath(url: string): boolean {
  const path = url.split("?")[0] ?? url;
  return path.startsWith("/v1/anywhere");
}

export function registerAnywhereRoutes(app: AppServer, deps: AnywhereRouteDeps): void {
  const { env, pool, bus } = deps;
  const store = new TurnStore(pool);
  const quotas = new QuotaService(pool, env);
  const adapterSet: AdapterSet = deps.adapterSet;
  const signingKey = Buffer.from(env.SG_DEVICE_SIGNING_KEY, "base64");
  const allowedOrigins = new Set(env.SG_ALLOWED_EXTENSION_IDS);

  app.addHook("onRequest", async (request, reply) => {
    if (!anywherePath(request.url)) return;

    const headerOrigin = request.headers[EXTENSION_ORIGIN_HEADER];
    const origin =
      typeof request.headers.origin === "string" && request.headers.origin.length > 0
        ? request.headers.origin
        : typeof headerOrigin === "string" && headerOrigin.length > 0
          ? headerOrigin
          : undefined;
    if (origin === undefined || !allowedOrigins.has(origin)) {
      if (origin !== undefined) {
        void reply.header("access-control-allow-origin", origin);
        void reply.header("vary", "origin");
      }
      sendError(reply, 403, "origin_rejected", "origin is not an allowed extension");
      return reply;
    }
    void reply.header("access-control-allow-origin", origin);
    void reply.header("vary", "origin");
    void reply.header("access-control-allow-private-network", "true");
    if (request.method === "OPTIONS") {
      void reply
        .header("access-control-allow-methods", "GET, POST")
        .header(
          "access-control-allow-headers",
          `content-type, ${TOKEN_HEADER}, ${EXTENSION_ORIGIN_HEADER}, last-event-id`,
        )
        .header("access-control-allow-private-network", "true")
        .header("access-control-max-age", "600")
        .status(204)
        .send();
      return reply;
    }
    return undefined;
  });

  function authenticate(request: FastifyRequest, reply: FastifyReply): DeviceTokenClaims | null {
    const token = request.headers[TOKEN_HEADER];
    if (typeof token !== "string") {
      sendError(reply, 401, "unauthorized", "missing device session token");
      return null;
    }
    const claims = verifyDeviceToken(token, signingKey, Math.floor(Date.now() / 1000));
    if (claims === null) {
      sendError(reply, 401, "unauthorized", "invalid or expired device session token");
      return null;
    }
    return claims;
  }

  app.post("/v1/anywhere/device", async (request, reply) => {
    const body = deviceRegisterRequestSchema.safeParse(request.body);
    if (!body.success) {
      sendError(reply, 400, "bad_request", "invalid device registration");
      return;
    }
    const registrations = await quotas.bumpIpRegistrations(request.ip, new Date());
    if (registrations > DEVICE_REGISTRATIONS_PER_IP_PER_DAY) {
      sendError(
        reply,
        429,
        "rate_limited",
        "too many device registrations from this address today",
        resetsAtOf(new Date()),
      );
      return;
    }
    await pool.query(
      `INSERT INTO device (id) VALUES ($1)
       ON CONFLICT (id) DO UPDATE SET last_seen_at = now()`,
      [body.data.deviceId],
    );
    const { token, claims } = signDeviceToken(
      body.data.deviceId,
      signingKey,
      Math.floor(Date.now() / 1000),
    );
    await reply.status(200).send({
      sessionToken: token,
      expiresAt: new Date(claims.expiresAt * 1000).toISOString(),
    });
  });

  app.post("/v1/anywhere/task", async (request, reply) => {
    const claims = authenticate(request, reply);
    if (claims === null) return;
    const body = taskRequestSchema.safeParse(request.body);
    if (!body.success) {
      sendError(reply, 400, "bad_request", "invalid task request");
      return;
    }
    const now = new Date();
    const quota = await quotas.deviceQuota(claims.deviceId, now);
    if (quota.used >= quota.limit) {
      sendError(reply, 429, "quota_exhausted", "the daily allowance is spent", quota.resetsAt);
      return;
    }
    const ipTasks = await quotas.bumpIpTaskCount(request.ip, now);
    if (ipTasks > env.SG_DAILY_IP_QUOTA) {
      sendError(
        reply,
        429,
        "rate_limited",
        "too many tasks from this address today",
        quota.resetsAt,
      );
      return;
    }
    const turnId = randomUUID();
    await store.createTurn({
      turnId,
      deviceId: claims.deviceId,
      origin: body.data.origin,
      tier: body.data.tier,
      taskText: body.data.taskText,
    });
    request.log.info({ turnId, origin: body.data.origin }, "anywhere turn accepted");
    deps.agent?.start({
      turnId,
      deviceId: claims.deviceId,
      origin: body.data.origin,
      url: body.data.url,
      tier: body.data.tier,
      taskText: body.data.taskText,
      digest: body.data.digest,
      adapter: matchAdapter(adapterSet.adapters, new URL(body.data.origin).hostname),
    });
    await reply.status(202).send({ turnId, quota });
  });

  app.get("/v1/anywhere/stream", async (request, reply) => {
    const claims = authenticate(request, reply);
    if (claims === null) return;
    const query = request.query as Record<string, unknown>;
    const turnId = typeof query["turnId"] === "string" ? query["turnId"] : "";
    const turn = await store.turnForDevice(turnId, claims.deviceId);
    if (turn === null) {
      sendError(reply, 404, "not_found", "no such turn for this device");
      return;
    }
    const lastEventId = request.headers["last-event-id"];
    const afterRaw = typeof query["after"] === "string" ? query["after"] : null;
    const after =
      afterRaw !== null && /^-?\d+$/.test(afterRaw)
        ? Number(afterRaw)
        : typeof lastEventId === "string" && /^\d+$/.test(lastEventId)
          ? Number(lastEventId)
          : -1;

    reply.hijack();
    const raw = reply.raw;
    const allowOrigin = reply.getHeader("access-control-allow-origin");
    raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
      "access-control-allow-origin": typeof allowOrigin === "string" ? allowOrigin : "",
      vary: "origin",
    });
    raw.write(":ok\n\n");

    const state = { delivered: after, pumping: false, pumpAgain: false, closed: false };
    const pendingWork = (): boolean => state.pumpAgain && !state.closed;

    const pump = async (): Promise<void> => {
      if (state.pumping) {
        state.pumpAgain = true;
        return;
      }
      state.pumping = true;
      try {
        do {
          state.pumpAgain = false;
          const events = await store.eventsAfter(turnId, state.delivered);
          for (const event of events) {
            if (state.closed) return;
            if (event.seq <= state.delivered) continue;
            raw.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
            state.delivered = event.seq;
          }
        } while (pendingWork());
      } finally {
        state.pumping = false;
      }
    };

    const unsubscribe = bus.subscribe(turnId, () => {
      void pump();
    });
    const heartbeat = setInterval(() => {
      if (!state.closed) raw.write(":hb\n\n");
    }, 15_000);

    request.raw.on("close", () => {
      state.closed = true;
      clearInterval(heartbeat);
      unsubscribe();
    });

    await pump();
  });

  app.post("/v1/anywhere/action-result", async (request, reply) => {
    const claims = authenticate(request, reply);
    if (claims === null) return;
    const body = actionResultRequestSchema.safeParse(request.body);
    if (!body.success) {
      sendError(reply, 400, "bad_request", "invalid action result");
      return;
    }
    const turn = await store.turnForDevice(body.data.turnId, claims.deviceId);
    if (turn === null) {
      sendError(reply, 404, "not_found", "no such turn for this device");
      return;
    }
    const inserted = await pool.query(
      `INSERT INTO action_result (action_id, turn_id, result, digest) VALUES ($1, $2, $3, $4)
       ON CONFLICT (action_id) DO NOTHING`,
      [
        body.data.actionId,
        body.data.turnId,
        JSON.stringify(body.data.result),
        body.data.digest === null ? null : JSON.stringify(body.data.digest),
      ],
    );
    if (inserted.rowCount === 1) {
      await store.appendTrajectory(body.data.turnId, "action-result", {
        actionId: body.data.actionId,
        result: body.data.result,
      });
    }
    await reply.status(204).send();
  });

  app.post("/v1/anywhere/confirm", async (request, reply) => {
    const claims = authenticate(request, reply);
    if (claims === null) return;
    const body = anywhereConfirmRequestSchema.safeParse(request.body);
    if (!body.success) {
      sendError(reply, 400, "bad_request", "invalid confirmation");
      return;
    }
    const turn = await store.turnForDevice(body.data.turnId, claims.deviceId);
    if (turn === null) {
      sendError(reply, 404, "not_found", "no such turn for this device");
      return;
    }
    const inserted = await pool.query(
      `INSERT INTO confirmation (action_id, turn_id, params_hash, approved) VALUES ($1, $2, $3, $4)
       ON CONFLICT (action_id) DO NOTHING`,
      [body.data.actionId, body.data.turnId, body.data.paramsHash, body.data.approved],
    );
    if (inserted.rowCount === 1) {
      await store.appendTrajectory(body.data.turnId, "confirmation", {
        actionId: body.data.actionId,
        paramsHash: body.data.paramsHash,
        approved: body.data.approved,
      });
    }
    await reply.status(204).send();
  });

  app.post("/v1/anywhere/erase", async (request, reply) => {
    const claims = authenticate(request, reply);
    if (claims === null) return;
    await pool.query("SELECT erase_device($1)", [claims.deviceId]);
    await reply.status(204).send();
  });

  app.get("/v1/anywhere/quota", async (request, reply) => {
    const claims = authenticate(request, reply);
    if (claims === null) return;
    const quota: Quota = await quotas.deviceQuota(claims.deviceId, new Date());
    await reply.status(200).send({ quota });
  });

  app.get("/v1/anywhere/adapters", async (request, reply) => {
    const claims = authenticate(request, reply);
    if (claims === null) return;
    await reply.status(200).send(adapterSet);
  });
}


