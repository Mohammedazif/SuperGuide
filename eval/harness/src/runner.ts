import { FIXTURE_ROUTE_REGISTRY, SEED_ACCOUNT_ID, buildFixtureApp, openApiDocument } from "@superguide/fixture-app";
import { ApiTaskVerifier, ConfirmationRegistry, EphemeralBus, ModelProcedureMatcher, NoEscalationSink, NoKnowledgeRetriever, NoProcedureMatcher, NoTaskVerifier, PendingCalls, ScriptedModelClient, createDatabase, createTurnExecutor, ingestOpenApi, parseEnvironment, readJournalSince, runMigrations, type DatabaseHandle, withProduct } from "@superguide/control-plane";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { pino } from "pino";
import type { CapabilityRegistry, RegisteredCapability } from "@superguide/executor";
import { loadProcedure } from "@superguide/procedures";
import { SimulatedBrowser } from "./browser.js";
import { RefResolvingModelClient } from "./refs.js";
import type { EvalTask } from "./task.js";
import { score, type PredicateOutcome } from "./scorer.js";

export interface TaskResult {
  id: string;
  title: string;
  passed: boolean;
  resolution: string;
  expectedResolution: string;
  ladderReached: string | null;
  expectedLadder: string | null;
  steps: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  latencyMs: number;
  predicates: PredicateOutcome[];
  failureDetail: string | null;
}

export interface HarnessOptions {
  variant: "a" | "b";
  databaseUrl: string;
  migrationUrl: string;
}

export interface Harness {
  fixtureUrl: string;
  run(task: EvalTask): Promise<TaskResult>;
  close(): Promise<void>;
}

function environment(task: EvalTask, databaseUrl: string, migrationUrl: string) {
  return parseEnvironment({
    SG_DATABASE_URL: databaseUrl,
    SG_MIGRATION_DATABASE_URL: migrationUrl,
    SG_PUBLIC_ORIGIN: "http://127.0.0.1:8080",
    ANTHROPIC_API_KEY: "eval-recorded-transcript",
    SG_SESSION_SIGNING_KEY: Buffer.alloc(32, 7).toString("base64"),
    SG_SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
    SG_WEBHOOK_SIGNING_KEY: Buffer.alloc(32, 11).toString("base64"),
    SG_LOG_LEVEL: "silent",
    SG_STEP_BUDGET: String(task.stepBudget),
    SG_ENABLE_GROUNDED_ACTIONS: String(task.groundedActions),
  });
}

export async function createHarness(options: HarnessOptions): Promise<Harness> {
  await runMigrations(options.migrationUrl);

  const fixture = buildFixtureApp({});
  await fixture.app.listen({ port: 0, host: "127.0.0.1" });
  const address = fixture.app.server.address();
  if (address === null || typeof address === "string") throw new Error("no fixture port");
  const fixtureUrl = `http://127.0.0.1:${String(address.port)}`;

  const database: DatabaseHandle = createDatabase(options.databaseUrl, 5);
  const logger = pino({ level: "silent" });

  async function provisionProduct(task: EvalTask): Promise<string> {
    const client = new pg.Client({ connectionString: options.migrationUrl });
    await client.connect();
    try {
      const tenant = await client.query<{ id: string }>(
        "INSERT INTO tenant (name) VALUES ($1) RETURNING id",
        [`eval-${task.id}-${randomUUID()}`],
      );
      const tenantId = tenant.rows[0]?.id ?? "";

      const product = await client.query<{ id: string }>(
        `INSERT INTO product
           (tenant_id, name, origin_allowlist, jwt_algorithms, route_registry, redaction_allowlist,
            grounded_actions_enabled, retention_days, api_base_url)
         VALUES ($1, $2, '{https://app.example}', '{RS256}', $3, $4, $5, 90, $6) RETURNING id`,
        [
          tenantId,
          task.id,
          JSON.stringify(FIXTURE_ROUTE_REGISTRY),
          JSON.stringify({
            fieldNames: ["postal_code", "city", "line1", "line2", "country", "registration_number", "enforced_domain"],
          }),
          task.groundedActions,
          fixtureUrl,
        ],
      );
      const productId = product.rows[0]?.id ?? "";

      const ingested = ingestOpenApi(openApiDocument(fixtureUrl));
      if (!ingested.ok) throw new Error(ingested.reason);
      for (const tool of ingested.tools) {
        await client.query(
          `INSERT INTO tool (product_id, name, kind, risk_class, definition, expect_template, enabled)
           VALUES ($1, $2, $3, $4, $5, $6, true)`,
          [
            productId,
            tool.record.name,
            tool.record.kind,
            tool.record.riskClass,
            JSON.stringify(tool.record.definition),
            JSON.stringify(tool.record.expectTemplate),
          ],
        );
      }

      for (const capability of task.capabilities) {
        await client.query(
          `INSERT INTO tool (product_id, name, kind, risk_class, definition, expect_template, enabled)
           VALUES ($1, $2, 'capability', $3, $4, $5, true)`,
          [
            productId,
            `capability_${capability.name}`,
            capability.risk,
            JSON.stringify({
              kind: "capability",
              capability: capability.name,
              description: `The ${capability.name} capability.`,
              parameterSchema: { properties: {}, required: [] },
            }),
            JSON.stringify([{ kind: "capability_status", status: "ok" }]),
          ],
        );
      }

      if (task.procedure !== undefined) {
        const loaded = loadProcedure(task.procedure);
        if (!loaded.ok) throw new Error(`${task.id}: the procedure did not load`);
        await client.query(
          `INSERT INTO procedure (product_id, slug, version, body, source_yaml, active, created_by)
           VALUES ($1, $2, 1, $3, $4, true, 'eval')`,
          [productId, loaded.procedure.document.id, JSON.stringify(loaded.procedure.document), task.procedure],
        );
      }

      return productId;
    } finally {
      await client.end();
    }
  }

  async function provisionConversation(
    productId: string,
    task: EvalTask,
  ): Promise<{ conversationId: string; endUserId: string }> {
    const client = new pg.Client({ connectionString: options.migrationUrl });
    await client.connect();
    try {
      const endUser = await client.query<{ id: string }>(
        "INSERT INTO end_user (product_id, external_id, identity_tier, scopes) VALUES ($1, $2, $3, $4) RETURNING id",
        [productId, `eval-${randomUUID()}`, task.identity.tier, task.identity.scopes],
      );
      const endUserId = endUser.rows[0]?.id ?? "";
      const conversation = await client.query<{ id: string }>(
        "INSERT INTO conversation (product_id, end_user_id, status, resolution_state) VALUES ($1, $2, 'open', 'in_progress') RETURNING id",
        [productId, endUserId],
      );
      return { conversationId: conversation.rows[0]?.id ?? "", endUserId };
    } finally {
      await client.end();
    }
  }

  function applySeed(task: EvalTask): void {
    fixture.reset();
    const account = fixture.state.accounts.get(SEED_ACCOUNT_ID);
    const sso = fixture.state.sso.get(SEED_ACCOUNT_ID);
    if (account === undefined || sso === undefined) throw new Error("the fixture seed is missing");

    if (task.seed.billing_address !== undefined) account.billing_address = task.seed.billing_address;
    if (task.seed.plan !== undefined) account.plan = task.seed.plan;
    if (task.seed.registration_number !== undefined) {
      account.registration_number = task.seed.registration_number;
    }
    if (task.seed.sso_enabled !== undefined) sso.enabled = task.seed.sso_enabled;
    if (task.seed.enforced_domain !== undefined) sso.enforced_domain = task.seed.enforced_domain;
  }

  return {
    fixtureUrl,

    async run(task: EvalTask): Promise<TaskResult> {
      const startedAt = Date.now();
      applySeed(task);

      const productId = await provisionProduct(task);
      const { conversationId, endUserId } = await provisionConversation(productId, task);

      const registry: CapabilityRegistry = {
        get: (name) => {
          const declared = task.capabilities.find((entry) => entry.name === name);
          if (declared === undefined) return null;
          const capability: RegisteredCapability = {
            name,
            risk: declared.risk,
            parse: (input) => ({ success: true, data: input }),
            handler: () =>
              declared.reply.status === "ok"
                ? { status: "ok", data: declared.reply.data ?? null }
                : { status: "failed", message: declared.reply.errorCode ?? "the capability failed" },
          };
          return capability;
        },
        names: () => task.capabilities.map((entry) => entry.name),
      };

      const browser = await SimulatedBrowser.open({
        fixtureUrl,
        startPath: task.startPath,
        variant: options.variant,
        valueAllowlist: ["postal_code", "city", "line1", "line2", "country", "registration_number", "enforced_domain"],
        routeTemplates: new Map(FIXTURE_ROUTE_REGISTRY.routes.map((route) => [route.id, route.template])),
        capabilities: registry,
        groundedActionsEnabled: task.groundedActions,
      });

      const ephemeral = new EphemeralBus();
      const pendingCalls = new PendingCalls();
      const confirmations = new ConfirmationRegistry();

      ephemeral.subscribe(conversationId, (event) => {
        if (event.event === "action.executing") {
          void browser.perform(event.action).then((payload) => {
            pendingCalls.deliver(conversationId, event.action.toolCallId, payload);
          });
          return;
        }
        if (event.event === "action.confirm" && task.confirmations !== "ignore") {
          setTimeout(() => {
            confirmations.decide(
              conversationId,
              event.toolCallId,
              event.paramsHash,
              task.confirmations === "approve" ? "approved" : "denied",
            );
          }, 0);
        }
      });

      const model = new ScriptedModelClient({
        classifications:
          task.procedure === undefined
            ? []
            : [{ matches: [{ id: loadProcedureId(task.procedure), confidence: 0.95 }] }],
        script: task.transcript.map((turn) => ({
          toolName: turn.tool,
          toolInput: turn.input,
          ...(turn.text === undefined ? {} : { text: turn.text }),
        })),
      });

      const env = environment(task, options.databaseUrl, options.migrationUrl);

      const outcome = await createTurnExecutor({
        env,
        logger,
        db: database.db,
        ephemeral,
        pendingCalls,
        confirmations,
        modelClient: new RefResolvingModelClient(model, () => browser.digest()),
        procedureMatcher:
          task.procedure === undefined
            ? new NoProcedureMatcher()
            : new ModelProcedureMatcher(model, logger),
        knowledgeRetriever: new NoKnowledgeRetriever(),
        taskVerifier: task.procedure === undefined ? new NoTaskVerifier() : new ApiTaskVerifier(),
        escalationSink: new NoEscalationSink(),
      })({
        productId,
        conversationId,
        turnId: randomUUID(),
        identity: {
          tier: task.identity.tier,
          endUserId,
          externalId: "eval-user",
          scopes: task.identity.scopes,
          claims: { role: task.identity.role },
        },
        userMessage: task.message,
        digest: browser.digest(),
        url: browser.url,
        requestId: `eval-${task.id}`,
        signal: new AbortController().signal,
      }).catch((error: unknown) => ({
        resolutionState: "escalated" as const,
        summary: error instanceof Error ? error.message : String(error),
        closeConversation: true,
      }));

      const entries = await withProduct(database.db, productId, (tx) =>
        readJournalSince(tx, conversationId, 0),
      );
      const steps = entries.flatMap((entry) => (entry.kind === "step" ? [entry.step] : []));
      const messages = entries.flatMap((entry) =>
        entry.kind === "message" ? [entry.message.content.text] : [],
      );

      browser.close();

      const predicates = await score(task, {
        fixtureUrl,
        accountId: SEED_ACCOUNT_ID,
        seats: fixture.state.seats,
        messages,
      });

      const ladderReached = steps.at(-1)?.ladderLevel ?? null;
      const resolutionMatches = outcome.resolutionState === task.expect.resolution;
      const ladderMatches =
        task.expect.ladderLevel === null || ladderReached === task.expect.ladderLevel;
      const withinBudget = steps.length <= task.expect.maxSteps;
      const predicatesPassed = predicates.every((entry) => entry.satisfied);

      const failures: string[] = [];
      if (!resolutionMatches) {
        failures.push(`resolution was ${outcome.resolutionState}, expected ${task.expect.resolution}`);
      }
      if (!ladderMatches) {
        failures.push(`reached ${ladderReached ?? "no level"}, expected ${task.expect.ladderLevel ?? "any"}`);
      }
      if (!withinBudget) failures.push(`took ${String(steps.length)} steps`);
      for (const entry of predicates) {
        if (!entry.satisfied) failures.push(entry.detail);
      }

      return {
        id: task.id,
        title: task.title,
        passed: resolutionMatches && ladderMatches && withinBudget && predicatesPassed,
        resolution: outcome.resolutionState,
        expectedResolution: task.expect.resolution,
        ladderReached,
        expectedLadder: task.expect.ladderLevel,
        steps: steps.length,
        inputTokens: steps.reduce((total, step) => total + step.inputTokens, 0),
        outputTokens: steps.reduce((total, step) => total + step.outputTokens, 0),
        cacheReadTokens: steps.reduce((total, step) => total + step.cacheReadTokens, 0),
        latencyMs: Date.now() - startedAt,
        predicates,
        failureDetail: failures.length === 0 ? null : failures.join("; "),
      };
    },

    async close(): Promise<void> {
      await database.close();
      await fixture.app.close();
    },
  };
}

function loadProcedureId(sourceYaml: string): string {
  const loaded = loadProcedure(sourceYaml);
  return loaded.ok ? loaded.procedure.document.id : "unknown";
}
