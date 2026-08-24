import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pino } from "pino";
import { sql } from "drizzle-orm";
import pg from "pg";
import { createDatabase, withProduct, type DatabaseHandle } from "../../apps/control-plane/src/db/client.js";
import { onboardProduct } from "../../apps/control-plane/src/onboarding/onboard.js";
import { readJournalSince } from "../../apps/control-plane/src/repository/journal.js";
import { createTurnExecutor } from "../../apps/control-plane/src/turn/loop.js";
import { ScriptedModelClient } from "../../apps/control-plane/src/model/scripted-client.js";
import { NoKnowledgeRetriever, NoProcedureMatcher, NoTaskVerifier } from "../../apps/control-plane/src/turn/ports.js";
import { NoEscalationSink } from "../../apps/control-plane/src/escalation/sink.js";
import { EphemeralBus } from "../../apps/control-plane/src/events/ephemeral.js";
import { PendingCalls } from "../../apps/control-plane/src/turn/pending-calls.js";
import { ConfirmationRegistry } from "../../apps/control-plane/src/turn/confirmations.js";
import { SEED_ACCOUNT_ID } from "../../apps/fixture-app/src/data.js";
import { createTestProduct, startHarness, testEnvironment } from "../helpers/server.js";
import { signConsoleToken } from "../../apps/control-plane/src/auth/console-token.js";
import { startFixtureApp, type RunningFixture } from "../helpers/fixture.js";
import { appDatabaseUrl, migrationDatabaseUrl } from "../helpers/database.js";

describe("onboarding a product from its published spec", () => {
  let fixture: RunningFixture;
  let database: DatabaseHandle;
  let productId: string;

  beforeAll(async () => {
    fixture = await startFixtureApp({
      widgetScriptUrl: "https://cdn.trysuperguide.com/widget.js",
      widgetProductId: "prod_onboarding",
      apiUrl: "https://api.trysuperguide.com",
    });
    database = createDatabase(appDatabaseUrl(), 5);
    ({ productId } = await createTestProduct());
  });

  afterAll(async () => {
    await database.close();
    await fixture.close();
  });

  it("discovers the whole API surface and route table without any code change", async () => {
    const outcome = await withProduct(database.db, productId, (tx) =>
      onboardProduct(
        tx,
        {
          productId,
          openApiUrl: `${fixture.baseUrl}/openapi.json`,
          routeRegistryUrl: `${fixture.baseUrl}/route-registry.json`,
          apiBaseUrlOverride: fixture.baseUrl,
        },
        { signal: new AbortController().signal },
      ),
    );

    expect(outcome.toolsDiscovered).toBe(9);
    expect(outcome.toolsAwaitingReview).toBe(9);
    expect(outcome.routesDiscovered).toBe(6);
    expect(outcome.apiBaseUrl).toBe(fixture.baseUrl);
    expect(outcome.skipped).toEqual([]);

    const rows = await withProduct(database.db, productId, (tx) =>
      tx.execute<{ name: string; risk_class: string; enabled: boolean }>(
        sql`SELECT name, risk_class, enabled FROM tool ORDER BY name`,
      ),
    );

    const byName = new Map(rows.rows.map((row) => [row.name, row]));
    expect(byName.get("api_getAccount")?.risk_class).toBe("read");
    expect(byName.get("api_updateBillingAddress")?.risk_class).toBe("write");
    expect(byName.get("api_removeSeat")?.risk_class).toBe("destructive");
    expect(byName.get("api_inviteSeat")?.risk_class).toBe("communication");
    expect(byName.get("api_listInvoices")?.risk_class).toBe("financial");
    expect(byName.get("api_changeSubscription")?.risk_class).toBe("financial");

    for (const row of rows.rows) expect(row.enabled).toBe(false);
  });

  it("onboards over the console route the way an operator would", async () => {
    const { productId: freshProduct, tenantId } = await createTestProduct();
    const harness = await startHarness();
    try {
      const issuedAt = Math.floor(Date.now() / 1000);
      const cookie = `sg_console=${signConsoleToken(
        Buffer.from(testEnvironment().SG_SESSION_SIGNING_KEY, "base64"),
        { operatorEmail: "lead@northwind.example", tenantId, issuedAt, expiresAt: issuedAt + 3600 },
      )}`;

      const response = await fetch(
        `${harness.baseUrl}/internal/onboard?productId=${freshProduct}`,
        {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({
            openApiUrl: `${fixture.baseUrl}/openapi.json`,
            routeRegistryUrl: `${fixture.baseUrl}/route-registry.json`,
            apiBaseUrl: fixture.baseUrl,
          }),
        },
      );

      expect(response.status).toBe(200);
      const outcome = (await response.json()) as {
        toolsDiscovered: number;
        toolsAwaitingReview: number;
        routesDiscovered: number;
      };
      expect(outcome.toolsDiscovered).toBe(9);
      expect(outcome.toolsAwaitingReview).toBe(9);
      expect(outcome.routesDiscovered).toBe(6);

      const refused = await fetch(`${harness.baseUrl}/internal/onboard?productId=${freshProduct}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ openApiUrl: `${fixture.baseUrl}/openapi.json` }),
      });
      expect(refused.status).toBe(401);
    } finally {
      await harness.close();
    }
  });

  it("serves the script tag the integrating engineer pastes in", async () => {
    const page = await fetch(`${fixture.baseUrl}/settings/billing`);
    const html = await page.text();
    expect(html).toContain('id="superguide-widget"');
    expect(html).toContain('data-product-id="prod_onboarding"');
    expect(html).toContain('data-api-url="https://api.trysuperguide.com"');
    expect(html).toContain("async");
  });

  it("resolves a real request once a reviewer enables the operations", async () => {
    const client = new pg.Client({ connectionString: migrationDatabaseUrl() });
    await client.connect();
    try {
      await client.query(
        "UPDATE tool SET enabled = true WHERE product_id = $1 AND risk_class IN ('read','write')",
        [productId],
      );
    } finally {
      await client.end();
    }

    const seeded = await (async () => {
      const inner = new pg.Client({ connectionString: migrationDatabaseUrl() });
      await inner.connect();
      try {
        const endUser = await inner.query<{ id: string }>(
          "INSERT INTO end_user (product_id, external_id, identity_tier, scopes) VALUES ($1, $2, 'verified', '{}') RETURNING id",
          [productId, `user-${randomUUID()}`],
        );
        const endUserId = endUser.rows[0]?.id;
        if (endUserId === undefined) throw new Error("no end user");
        const conversation = await inner.query<{ id: string }>(
          "INSERT INTO conversation (product_id, end_user_id, status, resolution_state) VALUES ($1, $2, 'open', 'in_progress') RETURNING id",
          [productId, endUserId],
        );
        const conversationId = conversation.rows[0]?.id;
        if (conversationId === undefined) throw new Error("no conversation");
        return { conversationId, endUserId };
      } finally {
        await inner.end();
      }
    })();

    const scripted = new ScriptedModelClient({
      script: [
        {
          toolName: "api_getAccount",
          toolInput: { intent: "Read the account.", accountId: SEED_ACCOUNT_ID },
        },
        {
          toolName: "finish",
          toolInput: {
            intent: "Report.",
            summary: "Your plan is growth and you have 25 seats.",
            resolutionState: "resolved",
          },
        },
      ],
    });

    const outcome = await createTurnExecutor({
      env: testEnvironment({ SG_STEP_BUDGET: "4" }),
      logger: pino({ level: "silent" }),
      db: database.db,
      ephemeral: new EphemeralBus(),
      pendingCalls: new PendingCalls(),
      confirmations: new ConfirmationRegistry(),
      modelClient: scripted,
      procedureMatcher: new NoProcedureMatcher(),
      knowledgeRetriever: new NoKnowledgeRetriever(),
      taskVerifier: new NoTaskVerifier(),
      escalationSink: new NoEscalationSink(),
    })({
      productId,
      conversationId: seeded.conversationId,
      turnId: randomUUID(),
      identity: {
        tier: "verified",
        endUserId: seeded.endUserId,
        externalId: "dana",
        scopes: [],
        claims: {},
      },
      userMessage: "What plan are we on?",
      digest: null,
      url: "https://app.example/account",
      requestId: "req-onboard",
      signal: new AbortController().signal,
    });

    expect(outcome.resolutionState).toBe("resolved");

    const entries = await withProduct(database.db, productId, (tx) =>
      readJournalSince(tx, seeded.conversationId, 0),
    );
    const steps = entries.flatMap((entry) => (entry.kind === "step" ? [entry.step] : []));
    expect(steps).toHaveLength(1);
    expect(steps[0]?.expectOutcome.satisfied).toBe(true);
  });
});
