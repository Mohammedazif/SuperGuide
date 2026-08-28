import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { pino } from "pino";
import { buildFixtureApp } from "../../apps/fixture-app/src/server.js";
import { FIXTURE_ROUTE_REGISTRY, openApiDocument } from "../../apps/fixture-app/src/openapi.js";
import { buildServer, type AppServer } from "../../apps/control-plane/src/server.js";
import { parseEnvironment } from "../../apps/control-plane/src/env.js";
import { createDatabase, withProduct, type DatabaseHandle } from "../../apps/control-plane/src/db/client.js";
import { EventBus } from "../../apps/control-plane/src/anywhere/bus.js";
import { PostgresNotifier } from "../../apps/control-plane/src/events/notifier.js";
import { EphemeralBus } from "../../apps/control-plane/src/events/ephemeral.js";
import { StreamRegistry } from "../../apps/control-plane/src/events/stream.js";
import { PendingCalls } from "../../apps/control-plane/src/turn/pending-calls.js";
import { ConfirmationRegistry } from "../../apps/control-plane/src/turn/confirmations.js";
import { AsymmetricIdentityVerifier } from "../../apps/control-plane/src/auth/jwt-verifier.js";
import { SignJWT, exportSPKI, generateKeyPair } from "jose";
import { createRateLimiters } from "../../apps/control-plane/src/auth/rate-limit.js";
import { createAgentTurnRunner } from "../../apps/control-plane/src/turn/runner.js";
import { createTurnExecutor } from "../../apps/control-plane/src/turn/loop.js";
import { ScriptedModelClient, type ScriptedTurn } from "../../apps/control-plane/src/model/scripted-client.js";
import type { GenerateRequest, GenerateResult, ModelClient } from "../../apps/control-plane/src/model/client.js";
import { NoKnowledgeRetriever, NoProcedureMatcher, NoTaskVerifier } from "../../apps/control-plane/src/turn/ports.js";
import { NoEscalationSink } from "../../apps/control-plane/src/escalation/sink.js";
import { ingestOpenApi } from "../../apps/control-plane/src/tools/ingest-openapi.js";
import { runMigrations } from "../../apps/control-plane/src/db/migrate.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const WIDGET_BUNDLE = resolve(REPO_ROOT, "apps/widget/dist/widget.js");

function migrationUrl(): string {
  return process.env["SG_MIGRATION_DATABASE_URL"] ?? "postgres://sg_migrator:sg_migrator_dev@127.0.0.1:55432/superguide";
}

function appUrl(): string {
  return process.env["SG_DATABASE_URL"] ?? "postgres://sg_app:sg_app_dev@127.0.0.1:55432/superguide";
}

// Scripted turns cannot know observer-minted refs; {{ref:name}} is resolved from the latest digest.
const REF_PLACEHOLDER = /\{\{ref:([^}]+)\}\}/g;

function refsFromMessages(messages: readonly { content: unknown }[]): Map<string, string> {
  const found = new Map<string, string>();
  for (const message of messages) {
    const blocks = Array.isArray(message.content) ? message.content : [message.content];
    for (const block of blocks) {
      const text =
        typeof block === "string"
          ? block
          : typeof block === "object" && block !== null && "text" in block
            ? String((block as { text: unknown }).text)
            : "";
      for (const line of text.split("\n")) {
        const match = /^(e\d+) \S+ "([^"]*)"/.exec(line.trim());
        if (match?.[1] !== undefined && match[2] !== undefined) found.set(match[2], match[1]);
      }
    }
  }
  return found;
}

class RefResolvingModelClient implements ModelClient {
  readonly #inner: ScriptedModelClient;

  constructor(inner: ScriptedModelClient) {
    this.#inner = inner;
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    const result = await this.#inner.generate(request);
    const refs = refsFromMessages(request.messages);

    for (const block of result.message.content) {
      if (block.type !== "tool_use") continue;
      const input = block.input as Record<string, unknown>;
      for (const [key, value] of Object.entries(input)) {
        if (typeof value !== "string") continue;
        input[key] = value.replace(REF_PLACEHOLDER, (whole, name: string) => refs.get(name) ?? whole);
      }
    }
    return result;
  }

  classify: ModelClient["classify"] = (request) => this.#inner.classify(request);
}

const ISSUER = "https://auth.e2e.example";
const AUDIENCE = "superguide:e2e";

export interface E2EStack {
  mintIdentityToken(subject: string, scopes: readonly string[]): Promise<string>;
  fixtureUrl: string;
  apiUrl: string;
  productId: string;
  setScript(script: ScriptedTurn[]): void;
  fixtureState: ReturnType<typeof buildFixtureApp>["state"];
  resetFixture(): void;
  close(): Promise<void>;
}

export interface E2EOptions {
  strictCsp?: boolean;
  groundedActions?: boolean;
}

export async function startStack(options: E2EOptions = {}): Promise<E2EStack> {
  await runMigrations(migrationUrl());

  const fixture = buildFixtureApp({
    widgetBundlePath: WIDGET_BUNDLE,
    strictCsp: options.strictCsp ?? false,
  });
  await fixture.app.listen({ port: 0, host: "127.0.0.1" });
  const fixtureAddress = fixture.app.server.address();
  if (fixtureAddress === null || typeof fixtureAddress === "string") throw new Error("no fixture port");
  const fixtureUrl = `http://127.0.0.1:${String(fixtureAddress.port)}`;

  const keys = await generateKeyPair("RS256", { extractable: true });
  const spki = await exportSPKI(keys.publicKey);

  const client = new pg.Client({ connectionString: migrationUrl() });
  await client.connect();
  let productId: string;
  let tenantId: string;
  try {
    const tenant = await client.query<{ id: string }>(
      "INSERT INTO tenant (name) VALUES ($1) RETURNING id",
      [`e2e-${randomUUID()}`],
    );
    tenantId = tenant.rows[0]?.id ?? "";
    const product = await client.query<{ id: string }>(
      `INSERT INTO product
         (tenant_id, name, origin_allowlist, jwt_algorithms, jwt_issuer, jwt_audience,
          route_registry, redaction_allowlist, grounded_actions_enabled, retention_days, api_base_url)
       VALUES ($1, 'e2e product', $2, '{RS256}', $7, $8, $3, $4, $5, 90, $6) RETURNING id`,
      [
        tenantId,
        [fixtureUrl],
        JSON.stringify(FIXTURE_ROUTE_REGISTRY),
        JSON.stringify({ fieldNames: ["postal_code", "city", "line1", "registration_number"] }),
        options.groundedActions ?? false,
        fixtureUrl,
        ISSUER,
        AUDIENCE,
      ],
    );
    productId = product.rows[0]?.id ?? "";

    await client.query(
      "INSERT INTO product_secret (product_id, signing_public_key, rotated_at) VALUES ($1, $2, now())",
      [productId, spki],
    );

    const ingested = ingestOpenApi(openApiDocument(fixtureUrl));
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

    await client.query(
      `INSERT INTO tool (product_id, name, kind, risk_class, definition, expect_template, enabled)
       VALUES ($1, 'capability_highlight_invoice', 'capability', 'read', $2, $3, true)`,
      [
        productId,
        JSON.stringify({
          kind: "capability",
          capability: "highlight_invoice",
          description: "Highlight one invoice row.",
          parameterSchema: { properties: { invoiceId: { type: "string" } }, required: ["invoiceId"] },
        }),
        JSON.stringify([{ kind: "capability_status", status: "ok" }]),
      ],
    );
  } finally {
    await client.end();
  }

  const env = parseEnvironment({
    SG_DATABASE_URL: appUrl(),
    SG_MIGRATION_DATABASE_URL: migrationUrl(),
    SG_PUBLIC_ORIGIN: "http://127.0.0.1:8080",
    ANTHROPIC_API_KEY: "e2e-scripted-no-live-calls",
    SG_SESSION_SIGNING_KEY: Buffer.alloc(32, 7).toString("base64"),
    SG_SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
    SG_WEBHOOK_SIGNING_KEY: Buffer.alloc(32, 11).toString("base64"),
    SG_DEVICE_SIGNING_KEY: Buffer.alloc(32, 13).toString("base64"),
    SG_ALLOWED_EXTENSION_IDS: "chrome-extension://ghdcebndlanhmdeajdbbemcaihpenhoj",
    SG_LOG_LEVEL: process.env["E2E_LOG_LEVEL"] ?? "silent",
    SG_STEP_BUDGET: "8",
    SG_ENABLE_GROUNDED_ACTIONS: String(options.groundedActions ?? false),
  });

  const logger = pino({ level: env.SG_LOG_LEVEL });
  const database: DatabaseHandle = createDatabase(env.SG_DATABASE_URL, 5);
  const notifier = new PostgresNotifier(env.SG_DATABASE_URL, logger);
  await notifier.start();
  const anywhereBus = await EventBus.start(env.SG_DATABASE_URL);

  const ephemeral = new EphemeralBus();
  const pendingCalls = new PendingCalls();
  const confirmations = new ConfirmationRegistry();

  let script: ScriptedTurn[] = [];

  const turnRunner = createAgentTurnRunner({
    env,
    logger,
    db: database.db,
    ephemeral,
    pendingCalls,
    confirmations,
    execute: (context) =>
      createTurnExecutor({
        env,
        logger,
        db: database.db,
        ephemeral,
        pendingCalls,
        confirmations,
        modelClient: new RefResolvingModelClient(new ScriptedModelClient({ script })),
        procedureMatcher: new NoProcedureMatcher(),
        knowledgeRetriever: new NoKnowledgeRetriever(),
        taskVerifier: new NoTaskVerifier(),
        escalationSink: new NoEscalationSink(),
      })(context),
  });

  const app: AppServer = buildServer({
    env,
    logger,
    db: database.db,
    pool: database.pool,
    notifier,
    ephemeral,
    streams: new StreamRegistry(),
    pendingCalls,
    confirmations,
    turnRunner,
    identityVerifier: new AsymmetricIdentityVerifier({
      logger,
      keyFor: () => Promise.resolve({ jwksUrl: null, spki }),
    }),
    rateLimiters: createRateLimiters(),
    clock: { now: () => new Date() },
    heartbeatIntervalMs: 5000,
    anywhere: {
      bus: anywhereBus,
      agent: null,
      adapterSet: { version: 1, adapters: [] },
    },
  });

  await app.listen({ port: 0, host: "127.0.0.1" });
  const apiAddress = app.server.address();
  if (apiAddress === null || typeof apiAddress === "string") throw new Error("no api port");

  void withProduct;

  return {
    mintIdentityToken: (subject, scopes) =>
      new SignJWT({ scope: scopes.join(" "), role: "owner" })
        .setProtectedHeader({ alg: "RS256" })
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setSubject(subject)
        .setIssuedAt()
        .setExpirationTime("30m")
        .sign(keys.privateKey),
    fixtureUrl,
    apiUrl: `http://127.0.0.1:${String(apiAddress.port)}`,
    productId,
    setScript(next) {
      script = next;
    },
    get fixtureState() {
      return fixture.state;
    },
    resetFixture() {
      fixture.reset();
    },
    async close() {
      await app.close();
      await notifier.stop();
      await anywhereBus.stop();
      await database.close();
      await fixture.app.close();
    },
  };
}

export function pageUrl(stack: E2EStack, path: string, variant?: "a" | "b"): string {
  const url = new URL(path, stack.fixtureUrl);
  url.searchParams.set("sgProduct", stack.productId);
  url.searchParams.set("sgApi", stack.apiUrl);
  if (variant !== undefined) url.searchParams.set("variant", variant);
  return url.toString();
}
