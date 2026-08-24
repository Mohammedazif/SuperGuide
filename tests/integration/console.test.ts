import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pino } from "pino";
import pg from "pg";
import { createDatabase, type DatabaseHandle } from "../../apps/control-plane/src/db/client.js";
import { createTurnExecutor } from "../../apps/control-plane/src/turn/loop.js";
import { ScriptedModelClient } from "../../apps/control-plane/src/model/scripted-client.js";
import { ModelProcedureMatcher } from "../../apps/control-plane/src/turn/procedure-matcher.js";
import { ApiTaskVerifier } from "../../apps/control-plane/src/turn/task-verifier.js";
import { NoKnowledgeRetriever } from "../../apps/control-plane/src/turn/ports.js";
import { NoEscalationSink } from "../../apps/control-plane/src/escalation/sink.js";
import { EphemeralBus } from "../../apps/control-plane/src/events/ephemeral.js";
import { PendingCalls } from "../../apps/control-plane/src/turn/pending-calls.js";
import { ConfirmationRegistry } from "../../apps/control-plane/src/turn/confirmations.js";
import { signConsoleToken } from "../../apps/control-plane/src/auth/console-token.js";
import { loadProcedure } from "@superguide/procedures";
import { SEED_ACCOUNT_ID } from "../../apps/fixture-app/src/data.js";
import { createTestProduct, startHarness, testEnvironment, TEST_ORIGIN, type TestHarness } from "../helpers/server.js";
import { ingestFixtureTools, insertProcedure, startFixtureApp, type RunningFixture } from "../helpers/fixture.js";
import { appDatabaseUrl, migrationDatabaseUrl } from "../helpers/database.js";

const PROCEDURE = `
id: update_billing_address
version: 1
title: Update the billing address
when: user wants to change billing or invoice address
preconditions:
  - user.verified
steps:
  - prefer_api:
      operation: updateBillingAddress
success:
  - api:
      operation: getAccount
      params:
        accountId: "{{params.accountId}}"
      json_path: $.billing_address.postal_code
      equals: "{{params.postal_code}}"
`;

const NEW_PROCEDURE = `
id: manage_seats
version: 1
title: Manage seats on the account
when: user wants to add or remove a seat
preconditions:
  - user.verified
steps:
  - prefer_api:
      operation: listSeats
policy:
  never: [remove seat]
  confirm: []
  escalate_if: []
`;

describe("the console", () => {
  let fixture: RunningFixture;
  let database: DatabaseHandle;
  let harness: TestHarness;
  let productId: string;
  let tenantId: string;
  let conversationId: string;
  let cookie: string;
  let runOutcome: { resolutionState: string; summary: string };

  beforeAll(async () => {
    fixture = await startFixtureApp();
    database = createDatabase(appDatabaseUrl(), 5);
    harness = await startHarness();

    const created = await createTestProduct();
    productId = created.productId;
    tenantId = created.tenantId;
    await ingestFixtureTools({ productId, apiBaseUrl: fixture.baseUrl });

    const loaded = loadProcedure(PROCEDURE);
    if (!loaded.ok) throw new Error("the fixture procedure did not load");
    await insertProcedure(productId, "update_billing_address", PROCEDURE, loaded.procedure.document);

    const seeded = await (async () => {
      const client = new pg.Client({ connectionString: migrationDatabaseUrl() });
      await client.connect();
      try {
        const endUser = await client.query<{ id: string }>(
          "INSERT INTO end_user (product_id, external_id, identity_tier, scopes) VALUES ($1, $2, 'verified', '{}') RETURNING id",
          [productId, `user-${randomUUID()}`],
        );
        const endUserId = endUser.rows[0]?.id;
        if (endUserId === undefined) throw new Error("no end user");
        const conversation = await client.query<{ id: string }>(
          "INSERT INTO conversation (product_id, end_user_id, status, resolution_state) VALUES ($1, $2, 'open', 'in_progress') RETURNING id",
          [productId, endUserId],
        );
        const id = conversation.rows[0]?.id;
        if (id === undefined) throw new Error("no conversation");
        return { conversationId: id, endUserId };
      } finally {
        await client.end();
      }
    })();
    conversationId = seeded.conversationId;

    // A run that fails its final check, so the viewer has a real failed trajectory to render.
    const ephemeral = new EphemeralBus();
    const confirmations = new ConfirmationRegistry();
    ephemeral.subscribe(conversationId, (event) => {
      if (event.event !== "action.confirm") return;
      setTimeout(() => {
        confirmations.decide(conversationId, event.toolCallId, event.paramsHash, "approved");
      }, 0);
    });

    const model = new ScriptedModelClient({
      classifications: [{ matches: [{ id: "update_billing_address", confidence: 0.95 }] }],
      script: [
        {
          toolName: "api_updateBillingAddress",
          toolInput: {
            intent: "Change the postcode.",
            accountId: SEED_ACCOUNT_ID,
            line1: "18 Harbour Road",
            city: "Bristol",
            postal_code: "EH3 9DR",
            country: "TOO-LONG",
          },
        },
        {
          toolName: "finish",
          toolInput: { intent: "Report.", summary: "Done.", resolutionState: "resolved" },
        },
      ],
    });

    const logger = pino({ level: "silent" });
    runOutcome = await createTurnExecutor({
      env: testEnvironment({ SG_STEP_BUDGET: "4" }),
      logger,
      db: database.db,
      ephemeral,
      pendingCalls: new PendingCalls(),
      confirmations,
      modelClient: model,
      procedureMatcher: new ModelProcedureMatcher(model, logger),
      knowledgeRetriever: new NoKnowledgeRetriever(),
      taskVerifier: new ApiTaskVerifier(),
      escalationSink: new NoEscalationSink(),
    })({
      productId,
      conversationId,
      turnId: randomUUID(),
      identity: {
        tier: "verified",
        endUserId: seeded.endUserId,
        externalId: "dana",
        scopes: [],
        claims: {},
      },
      userMessage: "Change our billing postcode to EH3 9DR.",
      digest: null,
      url: "https://app.example/settings/billing",
      requestId: "req-console",
      signal: new AbortController().signal,
    });

    const issuedAt = Math.floor(Date.now() / 1000);
    cookie = `sg_console=${signConsoleToken(
      Buffer.from(testEnvironment().SG_SESSION_SIGNING_KEY, "base64"),
      {
        operatorEmail: "lead@northwind.example",
        tenantId,
        issuedAt,
        expiresAt: issuedAt + 3600,
      },
    )}`;
  });

  afterAll(async () => {
    await harness.close();
    await database.close();
    await fixture.close();
  });

  it("refuses a console route with no operator cookie", async () => {
    const response = await fetch(`${harness.baseUrl}/internal/procedures?productId=${productId}`);
    expect(response.status).toBe(401);
  });

  it("refuses a console route presented with a widget session token", async () => {
    const headers = {
      origin: TEST_ORIGIN,
      "content-type": "application/json",
      "x-sg-product-id": productId,
    };
    const session = await fetch(`${harness.baseUrl}/v1/session`, {
      method: "POST",
      headers,
      body: JSON.stringify({ productId }),
    });
    const token = ((await session.json()) as { sessionToken: string }).sessionToken;

    const response = await fetch(`${harness.baseUrl}/internal/procedures?productId=${productId}`, {
      headers: { authorization: `Bearer ${token}`, cookie },
    });
    expect(response.status).toBe(401);
  });

  it("renders a complete failed run in the trajectory viewer", async () => {
    const response = await fetch(
      `${harness.baseUrl}/internal/conversations/${conversationId}?productId=${productId}`,
      { headers: { cookie } },
    );
    expect(response.status).toBe(200);
    const html = await response.text();

    expect(html).toContain("Failure point");
    expect(html).toContain("step--unsatisfied");
    expect(html).toContain("not confirmed");
    expect(html).toContain("api_updateBillingAddress");
    expect(html).toContain("confirm");
    expect(html).toContain("Transcript");
    expect(html).toContain("could not confirm");
    expect(html).toMatch(/model claude-opus-5/);
    expect(html).toMatch(/request req-console/);
  });

  it("serves the same trajectory as json for a machine reader", async () => {
    const response = await fetch(
      `${harness.baseUrl}/internal/conversations/${conversationId}?productId=${productId}`,
      { headers: { cookie, accept: "application/json" } },
    );
    const body = (await response.json()) as {
      conversation: { resolutionState: string };
      steps: { expectOutcome: { satisfied: boolean }; result: { status: string } }[];
      messages: { content: { text: string } }[];
    };

    // The executor reports the outcome; persisting it to the conversation is the runner's job,
    // and this run was driven through the executor directly.
    expect(runOutcome.resolutionState).toBe("escalated");
    expect(body.steps.length).toBeGreaterThan(0);
    expect(body.steps.some((step) => !step.expectOutcome.satisfied)).toBe(true);
    expect(body.steps.some((step) => step.result.status === "failed")).toBe(true);
    expect(body.messages.some((message) => message.content.text.includes("could not confirm"))).toBe(true);
  });

  it("publishes a valid procedure as a new active version", async () => {
    const response = await fetch(`${harness.baseUrl}/internal/procedures?productId=${productId}`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ slug: "manage_seats", sourceYaml: NEW_PROCEDURE }),
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ valid: true, slug: "manage_seats", version: 1 });

    const again = await fetch(`${harness.baseUrl}/internal/procedures?productId=${productId}`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ slug: "manage_seats", sourceYaml: NEW_PROCEDURE }),
    });
    expect(((await again.json()) as { version: number }).version).toBe(2);

    const listed = await fetch(`${harness.baseUrl}/internal/procedures?productId=${productId}`, {
      headers: { cookie, accept: "application/json" },
    });
    const body = (await listed.json()) as {
      procedures: { slug: string; version: number; active: boolean }[];
    };
    const seats = body.procedures.filter((entry) => entry.slug === "manage_seats");
    expect(seats.filter((entry) => entry.active)).toHaveLength(1);
    expect(seats.find((entry) => entry.active)?.version).toBe(2);
  });

  it("refuses an invalid procedure loudly and does not activate it", async () => {
    const response = await fetch(`${harness.baseUrl}/internal/procedures?productId=${productId}`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        slug: "broken",
        sourceYaml: "id: broken\nversion: 1\ntitle: t\npreconditions:\n  - looks trustworthy\n",
      }),
    });

    expect(response.status).toBe(422);
    const body = (await response.json()) as { valid: boolean; issues: { path: string }[] };
    expect(body.valid).toBe(false);
    expect(body.issues.length).toBeGreaterThan(0);

    const listed = await fetch(`${harness.baseUrl}/internal/procedures?productId=${productId}`, {
      headers: { cookie, accept: "application/json" },
    });
    const listing = (await listed.json()) as { procedures: { slug: string }[] };
    expect(listing.procedures.some((entry) => entry.slug === "broken")).toBe(false);
  });
});
