import { randomUUID } from "node:crypto";
import pg from "pg";
import { pino } from "pino";
import { createDatabase, withProduct, type DatabaseHandle } from "../../apps/control-plane/src/db/client.js";
import { buildServer, type AppServer, type ServerDependencies } from "../../apps/control-plane/src/server.js";
import { parseEnvironment, type Environment } from "../../apps/control-plane/src/env.js";
import { PostgresNotifier } from "../../apps/control-plane/src/events/notifier.js";
import { EphemeralBus } from "../../apps/control-plane/src/events/ephemeral.js";
import { StreamRegistry } from "../../apps/control-plane/src/events/stream.js";
import { PendingCalls } from "../../apps/control-plane/src/turn/pending-calls.js";
import { ConfirmationRegistry } from "../../apps/control-plane/src/turn/confirmations.js";
import { RejectingIdentityVerifier } from "../../apps/control-plane/src/auth/identity-verifier.js";
import {
  createAgentTurnRunner,
  type TurnExecutor,
} from "../../apps/control-plane/src/turn/runner.js";
import { appendMessage, appendStep } from "../../apps/control-plane/src/repository/journal.js";
import type { AgentAction } from "@superguide/contract/public";
import { appDatabaseUrl, migrationDatabaseUrl } from "./database.js";

export const TEST_ORIGIN = "https://app.example";

export function testEnvironment(overrides: Record<string, string> = {}): Environment {
  return parseEnvironment({
    SG_DATABASE_URL: appDatabaseUrl(),
    SG_MIGRATION_DATABASE_URL: migrationDatabaseUrl(),
    SG_PUBLIC_ORIGIN: "http://127.0.0.1:8080",
    ANTHROPIC_API_KEY: "test-key-not-used",
    SG_SESSION_SIGNING_KEY: Buffer.alloc(32, 7).toString("base64"),
    SG_SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
    SG_WEBHOOK_SIGNING_KEY: Buffer.alloc(32, 11).toString("base64"),
    SG_LOG_LEVEL: "silent",
    ...overrides,
  });
}

export interface TestProduct {
  tenantId: string;
  productId: string;
}

export async function createTestProduct(options: {
  origins?: string[];
  groundedActions?: boolean;
  routes?: unknown;
} = {}): Promise<TestProduct> {
  const client = new pg.Client({ connectionString: migrationDatabaseUrl() });
  await client.connect();
  try {
    const tenant = await client.query<{ id: string }>(
      "INSERT INTO tenant (name) VALUES ($1) RETURNING id",
      [`tenant-${randomUUID()}`],
    );
    const tenantId = tenant.rows[0]?.id;
    if (tenantId === undefined) throw new Error("tenant insert returned no row");

    const product = await client.query<{ id: string }>(
      `INSERT INTO product
         (tenant_id, name, origin_allowlist, jwt_algorithms, route_registry,
          redaction_allowlist, grounded_actions_enabled, retention_days, api_base_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [
        tenantId,
        "fixture product",
        options.origins ?? [TEST_ORIGIN],
        ["RS256"],
        JSON.stringify(options.routes ?? { routes: [] }),
        JSON.stringify({ fieldNames: [] }),
        options.groundedActions ?? false,
        90,
        "http://127.0.0.1:8099",
      ],
    );
    const productId = product.rows[0]?.id;
    if (productId === undefined) throw new Error("product insert returned no row");
    return { tenantId, productId };
  } finally {
    await client.end();
  }
}

export interface TestHarness {
  app: AppServer;
  baseUrl: string;
  deps: ServerDependencies;
  database: DatabaseHandle;
  close: () => Promise<void>;
}

export async function startHarness(options: {
  execute?: TurnExecutor;
  env?: Record<string, string>;
  identityVerifier?: ServerDependencies["identityVerifier"];
} = {}): Promise<TestHarness> {
  const env = testEnvironment(options.env ?? {});
  const logger = pino({ level: "silent" });
  const database = createDatabase(env.SG_DATABASE_URL, 5);
  const notifier = new PostgresNotifier(env.SG_DATABASE_URL, logger);
  await notifier.start();

  const ephemeral = new EphemeralBus();
  const streams = new StreamRegistry();
  const pendingCalls = new PendingCalls();
  const confirmations = new ConfirmationRegistry();

  const turnRunner = createAgentTurnRunner({
    env,
    logger,
    db: database.db,
    ephemeral,
    pendingCalls,
    confirmations,
    execute:
      options.execute ??
      (() =>
        Promise.resolve({
          resolutionState: "resolved" as const,
          summary: "done",
          closeConversation: true,
        })),
  });

  const deps: ServerDependencies = {
    env,
    logger,
    db: database.db,
    notifier,
    ephemeral,
    streams,
    pendingCalls,
    confirmations,
    turnRunner,
    identityVerifier: options.identityVerifier ?? new RejectingIdentityVerifier(),
    clock: { now: () => new Date() },
    heartbeatIntervalMs: 1000,
  };

  const app = buildServer(deps);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (address === null || typeof address === "string") throw new Error("no bound port");

  return {
    app,
    baseUrl: `http://127.0.0.1:${address.port}`,
    deps,
    database,
    close: async () => {
      await app.close();
      await notifier.stop();
      await database.close();
    },
  };
}

export interface JournalWriter {
  message(productId: string, conversationId: string, text: string): Promise<number>;
  step(productId: string, conversationId: string, turnId: string): Promise<number>;
}

export function journalWriter(harness: TestHarness): JournalWriter {
  return {
    async message(productId: string, conversationId: string, text: string): Promise<number> {
      return withProduct(harness.database.db, productId, async (tx) => {
        const written = await appendMessage(tx, {
          conversationId,
          productId,
          role: "assistant",
          text,
        });
        return written.seq;
      });
    },
    async step(productId: string, conversationId: string, turnId: string): Promise<number> {
      const action: AgentAction = {
        type: "call_api",
        toolCallId: randomUUID(),
        intent: "read the account",
        expect: [{ kind: "http_status", in: [200] }],
        risk: "read",
        timeoutMs: 5000,
        tool: "getAccount",
        arguments: {},
      };
      return withProduct(harness.database.db, productId, async (tx) => {
        const written = await appendStep(tx, {
          conversationId,
          productId,
          turnId,
          ladderLevel: "L1",
          action,
          policyVerdict: { decision: "allow" },
          result: { status: "ok", data: { ok: true }, httpStatus: 200, url: null },
          expectOutcome: { satisfied: true, evaluatedBy: "rules", detail: "status 200" },
          model: null,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          latencyMs: 12,
          requestId: "test",
        });
        return written.seq;
      });
    },
  };
}
