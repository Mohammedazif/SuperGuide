import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvironmentOrExit } from "./env.js";
import { createLogger } from "./logging.js";
import { createDatabase, withProduct } from "./db/client.js";
import { EventBus } from "./anywhere/bus.js";
import { loadAdapterDirectory } from "./anywhere/adapters-fs.js";
import { TurnAgent } from "./anywhere/agent/loop.js";
import { makeProvider as makeAnywhereProvider } from "./anywhere/agent/provider.js";
import { TurnStore } from "./anywhere/store.js";
import { QuotaService } from "./anywhere/quota.js";
import { PostgresNotifier } from "./events/notifier.js";
import { EphemeralBus } from "./events/ephemeral.js";
import { StreamRegistry } from "./events/stream.js";
import { PendingCalls } from "./turn/pending-calls.js";
import { ConfirmationRegistry } from "./turn/confirmations.js";
import { AsymmetricIdentityVerifier } from "./auth/jwt-verifier.js";
import { createRateLimiters } from "./auth/rate-limit.js";
import { loadSigningPublicKey } from "./repository/product-secrets.js";
import { recoverInFlightTurns } from "./turn/recovery.js";
import { buildServer } from "./server.js";
import { createAgentTurnRunner } from "./turn/runner.js";
import { createTurnExecutor } from "./turn/loop.js";
import { makeModelClient } from "./model/provider.js";
import { PgVectorRetriever } from "./knowledge/retrieve.js";
import { HashingEmbeddingProvider } from "./knowledge/embedding.js";
import { ModelProcedureMatcher } from "./turn/procedure-matcher.js";
import { ApiTaskVerifier } from "./turn/task-verifier.js";
import { WebhookEscalationSink } from "./escalation/sink.js";

const SHUTDOWN_GRACE_MS = 15_000;

const ADAPTERS_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../adapters");

const env = loadEnvironmentOrExit();
const logger = createLogger(env);
const { db, pool, close: closeDatabase } = createDatabase(env.SG_DATABASE_URL);
const anywhereBus = await EventBus.start(env.SG_DATABASE_URL);
const adapterSet =
  env.SG_ADAPTERS === "on" ? loadAdapterDirectory(ADAPTERS_DIR) : { version: 1, adapters: [] };

const notifier = new PostgresNotifier(env.SG_DATABASE_URL, logger);
const ephemeral = new EphemeralBus();
const streams = new StreamRegistry();
const pendingCalls = new PendingCalls();
const confirmations = new ConfirmationRegistry();

await notifier.start();
await recoverInFlightTurns(db, logger);

const modelClient = makeModelClient(env);
const anywhereProvider = env.SG_ANYWHERE_AGENT === "on" ? makeAnywhereProvider(env) : null;

const anywhereAgent =
  anywhereProvider === null
    ? null
    : new TurnAgent({
        env,
        pool,
        store: new TurnStore(pool),
        quotas: new QuotaService(pool, env),
        plan: (request) => anywhereProvider.plan(request),
        scan: (strings) => anywhereProvider.scan(strings),
      });
if (anywhereAgent === null) {
  logger.warn("anywhere agent loop is off; /v1/anywhere/task will accept turns and never plan");
}

const turnRunner = createAgentTurnRunner({
  env,
  logger,
  db,
  ephemeral,
  pendingCalls,
  confirmations,
  execute: createTurnExecutor({
    env,
    logger,
    db,
    ephemeral,
    pendingCalls,
    confirmations,
    modelClient,
    procedureMatcher: new ModelProcedureMatcher(modelClient, logger),
    knowledgeRetriever: new PgVectorRetriever({
      db,
      embeddings: new HashingEmbeddingProvider(),
      logger,
    }),
    taskVerifier: new ApiTaskVerifier(),
    escalationSink: new WebhookEscalationSink({
      db,
      logger,
      signingKey: Buffer.from(env.SG_WEBHOOK_SIGNING_KEY, "base64"),
      publicOrigin: env.SG_PUBLIC_ORIGIN,
    }),
  }),
});

const app = buildServer({
  env,
  logger,
  db,
  pool,
  notifier,
  ephemeral,
  streams,
  pendingCalls,
  confirmations,
  turnRunner,
  anywhere: { bus: anywhereBus, agent: anywhereAgent, adapterSet },
  rateLimiters: createRateLimiters(),
  identityVerifier: new AsymmetricIdentityVerifier({
    logger,
    keyFor: (product) =>
      withProduct(db, product.id, async (tx) => ({
        jwksUrl: product.jwksUrl,
        spki: await loadSigningPublicKey(tx, product.id),
      })),
  }),
  clock: { now: () => new Date() },
});

await app.listen({ port: env.SG_PORT, host: "0.0.0.0" });
logger.info({ port: env.SG_PORT }, "control plane listening");

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "shutdown requested");

  try {
    await app.close();
  } catch (error) {
    logger.error({ err: error }, "server did not close cleanly");
  }

  await turnRunner.drain(SHUTDOWN_GRACE_MS);

  const abandoned = pendingCalls.abandonAll({
    status: "failed",
    error: { code: "TIMEOUT", message: "The service is shutting down." },
    digest: null,
    url: "",
  });
  const undecided = confirmations.abandonAll("timeout");

  const closed = streams.closeAll({
    name: "turn.failed",
    payload: {
      event: "turn.failed",
      turnId: "00000000-0000-4000-8000-000000000000",
      code: "server_shutdown",
      message: "The service is restarting. Reconnect to resume.",
    },
  });

  await notifier.stop();
  await anywhereBus.stop();
  await closeDatabase();
  logger.info({ abandoned, undecided, closed }, "shutdown complete");
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
