import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { pino } from "pino";
import { buildFixtureApp } from "@superguide/fixture-app";
import { FIXTURE_ROUTE_REGISTRY, openApiDocument } from "@superguide/fixture-app";
import {
  ConfirmationRegistry,
  EphemeralBus,
  EventBus,
  PendingCalls,
  PostgresNotifier,
  RejectingIdentityVerifier,
  ScriptedModelClient,
  StreamRegistry,
  buildServer,
  createAgentTurnRunner,
  createDatabase,
  createRateLimiters,
  createTurnExecutor,
  ingestOpenApi,
  makeModelClient,
  parseEnvironment,
  runMigrations,
  NoEscalationSink,
  NoKnowledgeRetriever,
  NoProcedureMatcher,
  NoTaskVerifier,
  type ModelClient,
} from "@superguide/control-plane";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const WIDGET_BUNDLE = resolve(REPO_ROOT, "apps/widget/dist/widget.js");

const FIXTURE_PORT = 8099;
const API_PORT = 8080;

function read(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

const PROVIDER =
  process.env["SG_MODEL_PROVIDER"] === "openai" || process.env["SG_MODEL_PROVIDER"] === "gemini"
    ? process.env["SG_MODEL_PROVIDER"]
    : "anthropic";
const PROVIDER_KEY_NAME =
  PROVIDER === "openai"
    ? "OPENAI_API_KEY"
    : PROVIDER === "gemini"
      ? "GEMINI_API_KEY"
      : "ANTHROPIC_API_KEY";

function liveKey(): string | null {
  const key = process.env[PROVIDER_KEY_NAME];
  if (key === undefined || key.length === 0) return null;
  if (/^(sg-local|test-key|eval-|e2e-)/.test(key)) return null;
  return key;
}

// Without a provider key the demo still has to do something visible, so it replays a short
// recorded transcript. The banner says which one is running; nothing here pretends otherwise.
const RECORDED = [
  {
    text: "Let me read your account.",
    toolName: "api_getAccount",
    toolInput: { intent: "Read the account.", accountId: "acct_01HQ8G7Z2K" },
  },
  {
    toolName: "finish",
    toolInput: {
      intent: "Report what the account says.",
      summary:
        "You are on the growth plan with 25 seats, billed to 18 Harbour Road, Bristol BS1 4TT.",
      resolutionState: "resolved" as const,
    },
  },
];

async function provision(migrationUrl: string, fixtureOrigin: string): Promise<string> {
  const client = new pg.Client({ connectionString: migrationUrl });
  await client.connect();
  try {
    const existing = await client.query<{ id: string }>(
      "SELECT id FROM product WHERE name = 'demo product' ORDER BY created_at DESC LIMIT 1",
    );
    const found = existing.rows[0]?.id;
    if (found !== undefined) {
      await client.query("UPDATE product SET origin_allowlist = $1, api_base_url = $2 WHERE id = $3", [
        [fixtureOrigin],
        fixtureOrigin,
        found,
      ]);
      return found;
    }

    const tenant = await client.query<{ id: string }>(
      "INSERT INTO tenant (name) VALUES ($1) RETURNING id",
      [`demo-${randomUUID()}`],
    );
    const tenantId = tenant.rows[0]?.id;
    if (tenantId === undefined) throw new Error("tenant insert returned no row");

    const product = await client.query<{ id: string }>(
      `INSERT INTO product
         (tenant_id, name, origin_allowlist, jwt_algorithms, route_registry, redaction_allowlist,
          grounded_actions_enabled, retention_days, api_base_url)
       VALUES ($1, 'demo product', $2, '{RS256}', $3, $4, false, 90, $5) RETURNING id`,
      [
        tenantId,
        [fixtureOrigin],
        JSON.stringify(FIXTURE_ROUTE_REGISTRY),
        JSON.stringify({ fieldNames: ["postal_code", "city", "line1", "registration_number"] }),
        fixtureOrigin,
      ],
    );
    const productId = product.rows[0]?.id;
    if (productId === undefined) throw new Error("product insert returned no row");

    const ingested = ingestOpenApi(openApiDocument(fixtureOrigin));
    if (!ingested.ok) throw new Error(ingested.reason);

    for (const tool of ingested.tools) {
      await client.query(
        `INSERT INTO tool (product_id, name, kind, risk_class, definition, expect_template, enabled)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          productId,
          tool.record.name,
          tool.record.kind,
          tool.record.riskClass,
          JSON.stringify(tool.record.definition),
          JSON.stringify(tool.record.expectTemplate),
          tool.record.riskClass === "read" || tool.record.riskClass === "write",
        ],
      );
    }

    return productId;
  } finally {
    await client.end();
  }
}

async function listenOrExplain(
  start: (port: number) => Promise<unknown>,
  port: number,
  what: string,
): Promise<void> {
  try {
    await start(port);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "EADDRINUSE") {
      process.stderr.write(
        `\n  Port ${String(port)} is already taken, so ${what} could not start.\n` +
          `  Something else is listening there, most likely a demo that is still running.\n\n`,
      );
      process.exit(1);
    }
    throw error;
  }
}

async function main(): Promise<void> {
  const databaseUrl = read(
    "SG_DATABASE_URL",
    "postgres://sg_app:sg_app_dev@127.0.0.1:55432/superguide",
  );
  const migrationUrl = read(
    "SG_MIGRATION_DATABASE_URL",
    "postgres://sg_migrator:sg_migrator_dev@127.0.0.1:55432/superguide",
  );

  await runMigrations(migrationUrl);

  const fixture = buildFixtureApp({ widgetBundlePath: WIDGET_BUNDLE });
  await listenOrExplain(
    (port) => fixture.app.listen({ port, host: "127.0.0.1" }),
    FIXTURE_PORT,
    "the customer's product",
  );
  const fixtureOrigin = `http://127.0.0.1:${String(FIXTURE_PORT)}`;

  const productId = await provision(migrationUrl, fixtureOrigin);

  const key = liveKey();
  const env = parseEnvironment({
    SG_DATABASE_URL: databaseUrl,
    SG_MIGRATION_DATABASE_URL: migrationUrl,
    SG_PORT: String(API_PORT),
    SG_PUBLIC_ORIGIN: `http://127.0.0.1:${String(API_PORT)}`,
    SG_MODEL_PROVIDER: key === null ? "anthropic" : PROVIDER,
    ANTHROPIC_API_KEY: read("ANTHROPIC_API_KEY", "demo-recorded-transcript"),
    OPENAI_API_KEY: read("OPENAI_API_KEY", ""),
    GEMINI_API_KEY: read("GEMINI_API_KEY", ""),
    SG_SESSION_SIGNING_KEY: read("SG_SESSION_SIGNING_KEY", Buffer.alloc(32, 7).toString("base64")),
    SG_SECRET_ENCRYPTION_KEY: read("SG_SECRET_ENCRYPTION_KEY", Buffer.alloc(32, 9).toString("base64")),
    SG_WEBHOOK_SIGNING_KEY: read("SG_WEBHOOK_SIGNING_KEY", Buffer.alloc(32, 11).toString("base64")),
    SG_DEVICE_SIGNING_KEY: read("SG_DEVICE_SIGNING_KEY", Buffer.alloc(32, 13).toString("base64")),
    SG_ALLOWED_EXTENSION_IDS: read(
      "SG_ALLOWED_EXTENSION_IDS",
      "chrome-extension://ghdcebndlanhmdeajdbbemcaihpenhoj",
    ),
    SG_LOG_LEVEL: read("SG_LOG_LEVEL", "info"),
  });

  const logger = pino({ level: env.SG_LOG_LEVEL });
  const { db, pool, close } = createDatabase(env.SG_DATABASE_URL);
  const notifier = new PostgresNotifier(env.SG_DATABASE_URL, logger);
  await notifier.start();
  const anywhereBus = await EventBus.start(env.SG_DATABASE_URL);

  const ephemeral = new EphemeralBus();
  const pendingCalls = new PendingCalls();
  const confirmations = new ConfirmationRegistry();

  const model: ModelClient =
    key === null ? new ScriptedModelClient({ script: RECORDED }) : makeModelClient(env);

  const turnRunner = createAgentTurnRunner({
    env,
    logger,
    db,
    ephemeral,
    pendingCalls,
    confirmations,
    execute: (context) =>
      createTurnExecutor({
        env,
        logger,
        db,
        ephemeral,
        pendingCalls,
        confirmations,
        modelClient: key === null ? new ScriptedModelClient({ script: RECORDED }) : model,
        procedureMatcher: new NoProcedureMatcher(),
        knowledgeRetriever: new NoKnowledgeRetriever(),
        taskVerifier: new NoTaskVerifier(),
        escalationSink: new NoEscalationSink(),
      })(context),
  });

  const app = buildServer({
    env,
    logger,
    db,
    pool,
    notifier,
    ephemeral,
    streams: new StreamRegistry(),
    pendingCalls,
    confirmations,
    turnRunner,
    identityVerifier: new RejectingIdentityVerifier(),
    rateLimiters: createRateLimiters(),
    clock: { now: () => new Date() },
    anywhere: {
      bus: anywhereBus,
      agent: null,
      adapterSet: { version: 1, adapters: [] },
    },
  });

  await listenOrExplain(
    (port) => app.listen({ port, host: "127.0.0.1" }),
    env.SG_PORT,
    "the control plane",
  );

  const url = `${fixtureOrigin}/account?sgProduct=${productId}&sgApi=http://127.0.0.1:${String(API_PORT)}`;

  process.stdout.write(
    [
      "",
      "  SuperGuide demo",
      "",
      `  Open this in a browser:  ${url}`,
      "",
      `  The customer's product   ${fixtureOrigin}`,
      `  The control plane        http://127.0.0.1:${String(API_PORT)}`,
      `  Product id               ${productId}`,
      "",
      key === null
        ? `  No ${PROVIDER_KEY_NAME} is set, so the planner is replaying a short recorded\n  transcript. Ask anything and it answers from the account. Set a real key to\n  run the actual model.`
        : `  A live model (provider ${PROVIDER}) is planning each turn.`,
      "",
      "  Try: What plan are we on?",
      "",
    ].join("\n"),
  );

  const shutdown = async (): Promise<void> => {
    await app.close();
    await notifier.stop();
    await anywhereBus.stop();
    await close();
    await fixture.app.close();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

await main();
