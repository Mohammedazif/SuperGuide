import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pino } from "pino";
import pg from "pg";
import { sql } from "drizzle-orm";
import { createDatabase, withProduct, type DatabaseHandle } from "../../apps/control-plane/src/db/client.js";
import { readJournalSince } from "../../apps/control-plane/src/repository/journal.js";
import { registerCapabilities } from "../../apps/control-plane/src/repository/tools.js";
import { compileTools } from "../../apps/control-plane/src/tools/compile.js";
import { loadTurnContext } from "../../apps/control-plane/src/turn/context.js";
import { createAgentTurnRunner } from "../../apps/control-plane/src/turn/runner.js";
import { createTurnExecutor } from "../../apps/control-plane/src/turn/loop.js";
import { ScriptedModelClient } from "../../apps/control-plane/src/model/scripted-client.js";
import { NoKnowledgeRetriever, NoProcedureMatcher, NoTaskVerifier } from "../../apps/control-plane/src/turn/ports.js";
import { NoEscalationSink } from "../../apps/control-plane/src/escalation/sink.js";
import { EphemeralBus } from "../../apps/control-plane/src/events/ephemeral.js";
import { PendingCalls } from "../../apps/control-plane/src/turn/pending-calls.js";
import { ConfirmationRegistry } from "../../apps/control-plane/src/turn/confirmations.js";
import { hashActionParameters } from "../../apps/control-plane/src/turn/loop.js";
import { SEED_ACCOUNT_ID } from "../../apps/fixture-app/src/data.js";
import type { AgentAction, ExecutorAction } from "@superguide/contract/public";
import { createTestProduct, startHarness, testEnvironment, TEST_ORIGIN, type TestHarness } from "../helpers/server.js";
import { ingestFixtureTools, startFixtureApp, type RunningFixture } from "../helpers/fixture.js";
import { openSse } from "../helpers/sse.js";
import { appDatabaseUrl, migrationDatabaseUrl } from "../helpers/database.js";

async function seedConversation(productId: string): Promise<{ conversationId: string; endUserId: string }> {
  const client = new pg.Client({ connectionString: migrationDatabaseUrl() });
  await client.connect();
  try {
    const endUser = await client.query<{ id: string }>(
      "INSERT INTO end_user (product_id, external_id, identity_tier, scopes) VALUES ($1, $2, 'verified', '{}') RETURNING id",
      [productId, `user-${randomUUID()}`],
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

describe("regressions", () => {
  let harness: TestHarness;
  let fixture: RunningFixture;
  let database: DatabaseHandle;
  let productId: string;

  beforeAll(async () => {
    harness = await startHarness();
    fixture = await startFixtureApp();
    database = createDatabase(appDatabaseUrl(), 5);
    ({ productId } = await createTestProduct());
    await ingestFixtureTools({ productId, apiBaseUrl: fixture.baseUrl });
  });

  afterAll(async () => {
    await harness.close();
    await database.close();
    await fixture.close();
  });

  const headers = (extra: Record<string, string> = {}): Record<string, string> => ({
    origin: TEST_ORIGIN,
    "content-type": "application/json",
    "x-sg-product-id": productId,
    ...extra,
  });

  async function openSession(): Promise<string> {
    const response = await fetch(`${harness.baseUrl}/v1/session?productId=${productId}`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ productId }),
    });
    return ((await response.json()) as { sessionToken: string }).sessionToken;
  }

  // Preflight carries no custom header, so the product must be resolvable from the URL.
  it("answers a CORS preflight that carries no custom header", async () => {
    const response = await fetch(`${harness.baseUrl}/v1/session?productId=${productId}`, {
      method: "OPTIONS",
      headers: {
        origin: TEST_ORIGIN,
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type, authorization, x-sg-product-id",
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(TEST_ORIGIN);
    expect(response.headers.get("access-control-allow-headers")).toContain("x-sg-product-id");
    expect(response.headers.get("access-control-allow-methods")).toContain("POST");
  });

  it("still refuses a preflight from an origin outside the allowlist", async () => {
    const response = await fetch(`${harness.baseUrl}/v1/session?productId=${productId}`, {
      method: "OPTIONS",
      headers: {
        origin: "https://evil.example",
        "access-control-request-method": "POST",
      },
    });

    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("re-announces an outstanding browser call to a stream that attaches afterwards", async () => {
    const token = await openSession();
    const chat = await fetch(`${harness.baseUrl}/v1/chat?productId=${productId}`, {
      method: "POST",
      headers: headers({ authorization: `Bearer ${token}` }),
      body: JSON.stringify({ conversationId: null, message: "hello", digest: null, url: "/" }),
    });
    const { conversationId } = (await chat.json()) as { conversationId: string };

    const action: ExecutorAction = {
      type: "navigate_route",
      toolCallId: randomUUID(),
      intent: "Take you to billing.",
      expect: [{ kind: "url_matches", pattern: "/settings/billing" }],
      risk: "read",
      timeoutMs: 30_000,
      routeId: "billing_settings",
      params: {},
    };

    void harness.deps.pendingCalls.register(
      action.toolCallId,
      conversationId,
      30_000,
      () => ({ status: "failed", error: { code: "TIMEOUT", message: "no result" }, digest: null, url: "" }),
      { turnId: randomUUID(), action, ladderLevel: "L3" },
    );

    const stream = await openSse(
      `${harness.baseUrl}/v1/stream?conversationId=${conversationId}&productId=${productId}`,
      headers({ authorization: `Bearer ${token}` }),
    );

    await stream.waitFor((frames) => frames.some((frame) => frame.event === "action.executing"));
    const announced = stream.frames.find((frame) => frame.event === "action.executing");
    expect((announced?.data as { action: { toolCallId: string } }).action.toolCallId).toBe(
      action.toolCallId,
    );

    stream.close();
    await stream.closed;
  });

  it("re-announces an outstanding confirmation to a stream that attaches afterwards", async () => {
    const token = await openSession();
    const chat = await fetch(`${harness.baseUrl}/v1/chat?productId=${productId}`, {
      method: "POST",
      headers: headers({ authorization: `Bearer ${token}` }),
      body: JSON.stringify({ conversationId: null, message: "hello", digest: null, url: "/" }),
    });
    const { conversationId } = (await chat.json()) as { conversationId: string };

    const action: AgentAction = {
      type: "call_api",
      toolCallId: randomUUID(),
      intent: "Change the postcode.",
      expect: [{ kind: "http_status", in: [200] }],
      risk: "write",
      timeoutMs: 20_000,
      tool: "api_updateBillingAddress",
      arguments: { accountId: SEED_ACCOUNT_ID, postal_code: "EH3 9DR" },
    };
    const paramsHash = hashActionParameters(action);

    void harness.deps.confirmations.request(action.toolCallId, conversationId, paramsHash, 30_000, {
      turnId: randomUUID(),
      toolCallId: action.toolCallId,
      paramsHash,
      verdict: { decision: "confirm", reason: "write_requires_confirmation", preview: "Change it." },
      preview: "Change it.",
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    });

    const stream = await openSse(
      `${harness.baseUrl}/v1/stream?conversationId=${conversationId}&productId=${productId}`,
      headers({ authorization: `Bearer ${token}` }),
    );

    await stream.waitFor((frames) => frames.some((frame) => frame.event === "action.confirm"));
    const announced = stream.frames.find((frame) => frame.event === "action.confirm");
    expect((announced?.data as { paramsHash: string }).paramsHash).toBe(paramsHash);

    stream.close();
    await stream.closed;
  });

  it("writes the closing message exactly once through the full runner", async () => {
    const { conversationId, endUserId } = await seedConversation(productId);
    const ephemeral = new EphemeralBus();

    const runner = createAgentTurnRunner({
      env: testEnvironment({ SG_STEP_BUDGET: "4" }),
      logger: pino({ level: "silent" }),
      db: database.db,
      ephemeral,
      pendingCalls: new PendingCalls(),
      confirmations: new ConfirmationRegistry(),
      execute: createTurnExecutor({
        env: testEnvironment({ SG_STEP_BUDGET: "4" }),
        logger: pino({ level: "silent" }),
        db: database.db,
        ephemeral,
        pendingCalls: new PendingCalls(),
        confirmations: new ConfirmationRegistry(),
        modelClient: new ScriptedModelClient({
          script: [
            {
              toolName: "api_getAccount",
              toolInput: { intent: "Read the account.", accountId: SEED_ACCOUNT_ID },
            },
            {
              toolName: "finish",
              toolInput: {
                intent: "Report.",
                summary: "You are on the growth plan.",
                resolutionState: "resolved",
              },
            },
          ],
        }),
        procedureMatcher: new NoProcedureMatcher(),
        knowledgeRetriever: new NoKnowledgeRetriever(),
        taskVerifier: new NoTaskVerifier(),
        escalationSink: new NoEscalationSink(),
      }),
    });

    runner.start({
      productId,
      conversationId,
      turnId: randomUUID(),
      identity: { tier: "verified", endUserId, externalId: "dana", scopes: [], claims: {} },
      userMessage: "What plan are we on?",
      digest: null,
      url: "https://app.example/account",
      requestId: "req-regression",
    });

    await runner.drain(20_000);

    const entries = await withProduct(database.db, productId, (tx) =>
      readJournalSince(tx, conversationId, 0),
    );
    const assistantMessages = entries.flatMap((entry) =>
      entry.kind === "message" && entry.message.role === "assistant" ? [entry.message.content.text] : [],
    );

    expect(assistantMessages).toEqual(["You are on the growth plan."]);
  });

  // jsonb does not preserve key order; a plain stringify would re-disable an unchanged capability.
  it("keeps a reviewed capability enabled when it is registered again unchanged", async () => {
    const descriptor = {
      name: "highlight_invoice",
      description: "Highlight one invoice row.",
      risk: "read" as const,
      parameters: { properties: { invoiceId: { type: "string" } }, required: ["invoiceId"] },
    };

    await withProduct(database.db, productId, (tx) =>
      registerCapabilities(tx, productId, [descriptor]),
    );

    const client = new pg.Client({ connectionString: migrationDatabaseUrl() });
    await client.connect();
    try {
      await client.query(
        "UPDATE tool SET enabled = true WHERE product_id = $1 AND name = 'capability_highlight_invoice'",
        [productId],
      );
    } finally {
      await client.end();
    }

    const outcome = await withProduct(database.db, productId, (tx) =>
      registerCapabilities(tx, productId, [descriptor]),
    );

    expect(outcome.registered).toEqual(["highlight_invoice"]);
    expect(outcome.awaitingReview).toEqual([]);

    const loaded = await withProduct(database.db, productId, (tx) =>
      loadTurnContext(tx, productId, randomUUID()),
    );
    const compiled = compileTools({
      product: loaded.product,
      tools: loaded.tools,
      groundedActionsEnabled: false,
    }).map((tool) => tool.name);

    expect(compiled).toContain("capability_highlight_invoice");
  });

  it("disables a capability again when its declaration genuinely changes", async () => {
    const outcome = await withProduct(database.db, productId, (tx) =>
      registerCapabilities(tx, productId, [
        {
          name: "highlight_invoice",
          description: "Highlight one invoice row, and scroll to it.",
          risk: "read",
          parameters: { properties: { invoiceId: { type: "string" } }, required: ["invoiceId"] },
        },
      ]),
    );

    expect(outcome.awaitingReview).toEqual(["highlight_invoice"]);

    const enabled = await withProduct(database.db, productId, (tx) =>
      tx.execute<{ enabled: boolean }>(
        sql`SELECT enabled FROM tool WHERE product_id = ${productId}::uuid
             AND name = 'capability_highlight_invoice'`,
      ),
    );
    expect(enabled.rows[0]?.enabled).toBe(false);
  });

  it("compiles no tool whose timeout the action envelope would refuse", async () => {
    const loaded = await withProduct(database.db, productId, (tx) =>
      loadTurnContext(tx, productId, randomUUID()),
    );
    const compiled = compileTools({
      product: loaded.product,
      tools: loaded.tools,
      groundedActionsEnabled: true,
    });

    expect(compiled.length).toBeGreaterThan(0);
    for (const tool of compiled) {
      expect({ tool: tool.name, withinCap: tool.timeoutMs > 0 && tool.timeoutMs <= 120_000 }).toEqual({
        tool: tool.name,
        withinCap: true,
      });
    }
  });
});
