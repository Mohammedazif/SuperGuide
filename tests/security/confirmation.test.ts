import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pino } from "pino";
import pg from "pg";
import { createDatabase, withProduct, type DatabaseHandle } from "../../apps/control-plane/src/db/client.js";
import { readJournalSince } from "../../apps/control-plane/src/repository/journal.js";
import { ConfirmationRegistry } from "../../apps/control-plane/src/turn/confirmations.js";
import { NoEscalationSink } from "../../apps/control-plane/src/escalation/sink.js";
import { EphemeralBus } from "../../apps/control-plane/src/events/ephemeral.js";
import { PendingCalls } from "../../apps/control-plane/src/turn/pending-calls.js";
import { createTurnExecutor, hashActionParameters } from "../../apps/control-plane/src/turn/loop.js";
import { ScriptedModelClient } from "../../apps/control-plane/src/model/scripted-client.js";
import {
  NoKnowledgeRetriever,
  NoProcedureMatcher,
  NoTaskVerifier,
} from "../../apps/control-plane/src/turn/ports.js";
import { SEED_ACCOUNT_ID } from "../../apps/fixture-app/src/data.js";
import { createTestProduct, testEnvironment, TEST_ORIGIN, startHarness, type TestHarness } from "../helpers/server.js";
import { ingestFixtureTools, startFixtureApp, type RunningFixture } from "../helpers/fixture.js";
import { appDatabaseUrl, migrationDatabaseUrl } from "../helpers/database.js";
import type { AgentAction } from "@superguide/contract/public";

function writeAction(overrides: Partial<AgentAction> = {}): AgentAction {
  return {
    type: "call_api",
    toolCallId: "toolu_A",
    intent: "Update the billing address.",
    expect: [{ kind: "http_status", in: [200] }],
    risk: "write",
    timeoutMs: 20_000,
    tool: "api_updateBillingAddress",
    arguments: { accountId: SEED_ACCOUNT_ID, postal_code: "EH3 9DR" },
    ...overrides,
  } as AgentAction;
}

async function seedConversation(productId: string): Promise<{ conversationId: string; endUserId: string }> {
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
    const conversationId = conversation.rows[0]?.id;
    if (conversationId === undefined) throw new Error("no conversation");
    return { conversationId, endUserId };
  } finally {
    await client.end();
  }
}

describe("confirmation is bound to one action", () => {
  it("approving action A does not authorise action B", async () => {
    const registry = new ConfirmationRegistry();
    const conversationId = randomUUID();

    const actionA = writeAction({ toolCallId: "toolu_A" });
    const actionB = writeAction({
      toolCallId: "toolu_B",
      arguments: { accountId: SEED_ACCOUNT_ID, postal_code: "SW1A 1AA" },
    });

    const hashA = hashActionParameters(actionA);
    const hashB = hashActionParameters(actionB);
    expect(hashA).not.toBe(hashB);

    const pendingA = registry.request(actionA.toolCallId, conversationId, hashA, 5000);
    const pendingB = registry.request(actionB.toolCallId, conversationId, hashB, 5000);

    expect(registry.decide(conversationId, actionA.toolCallId, hashA, "approved")).toEqual({
      status: "accepted",
    });
    expect(await pendingA).toBe("approved");

    // Approving A leaves B outstanding: there is no shared flag for it to consume.
    expect(registry.decide(conversationId, actionB.toolCallId, hashA, "approved")).toEqual({
      status: "params_mismatch",
    });

    expect(registry.decide(conversationId, actionB.toolCallId, hashB, "denied")).toEqual({
      status: "accepted",
    });
    expect(await pendingB).toBe("denied");
  });

  it("rejects a decision whose paramsHash does not match the proposed action", async () => {
    const registry = new ConfirmationRegistry();
    const conversationId = randomUUID();
    const action = writeAction();
    const hash = hashActionParameters(action);
    const pending = registry.request(action.toolCallId, conversationId, hash, 5000);

    expect(registry.decide(conversationId, action.toolCallId, "0".repeat(64), "approved")).toEqual({
      status: "params_mismatch",
    });

    expect(registry.decide(randomUUID(), action.toolCallId, hash, "approved")).toEqual({
      status: "unknown_call",
    });

    registry.decide(conversationId, action.toolCallId, hash, "denied");
    expect(await pending).toBe("denied");
  });

  it("hashes only the parameters, so a different intent still binds to the same action", () => {
    const action = writeAction();
    const restated = writeAction({ intent: "A different sentence about the same change." });
    expect(hashActionParameters(restated)).toBe(hashActionParameters(action));

    const different = writeAction({ arguments: { accountId: SEED_ACCOUNT_ID, postal_code: "X" } });
    expect(hashActionParameters(different)).not.toBe(hashActionParameters(action));
  });

  it("returns a mismatch over HTTP rather than performing the action", async () => {
    let harness: TestHarness | null = null;
    try {
      harness = await startHarness();
      const { productId } = await createTestProduct();
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
      const authorised = { ...headers, authorization: `Bearer ${token}` };

      const chat = await fetch(`${harness.baseUrl}/v1/chat`, {
        method: "POST",
        headers: authorised,
        body: JSON.stringify({ conversationId: null, message: "hi", digest: null, url: "/" }),
      });
      const { conversationId } = (await chat.json()) as { conversationId: string };

      const action = writeAction();
      const hash = hashActionParameters(action);
      const pending = harness.deps.confirmations.request(
        action.toolCallId,
        conversationId,
        hash,
        5000,
      );

      const tampered = await fetch(`${harness.baseUrl}/v1/confirm`, {
        method: "POST",
        headers: authorised,
        body: JSON.stringify({
          conversationId,
          toolCallId: action.toolCallId,
          paramsHash: "f".repeat(64),
          decision: "approved",
        }),
      });
      expect(tampered.status).toBe(409);
      expect(((await tampered.json()) as { error: { code: string } }).error.code).toBe(
        "params_hash_mismatch",
      );

      const honest = await fetch(`${harness.baseUrl}/v1/confirm`, {
        method: "POST",
        headers: authorised,
        body: JSON.stringify({
          conversationId,
          toolCallId: action.toolCallId,
          paramsHash: hash,
          decision: "approved",
        }),
      });
      expect(honest.status).toBe(202);
      expect(await pending).toBe("approved");
    } finally {
      await harness?.close();
    }
  });
});

describe("an anonymous session cannot write", () => {
  let fixture: RunningFixture;
  let database: DatabaseHandle;
  let productId: string;

  beforeAll(async () => {
    fixture = await startFixtureApp();
    database = createDatabase(appDatabaseUrl(), 5);
    ({ productId } = await createTestProduct());
    await ingestFixtureTools({ productId, apiBaseUrl: fixture.baseUrl });
  });

  afterAll(async () => {
    await database.close();
    await fixture.close();
  });

  it("blocks the write by policy and leaves the product unchanged", async () => {
    fixture.reset();
    const before = fixture.state.accounts.get(SEED_ACCOUNT_ID)?.billing_address.postal_code;
    const { conversationId, endUserId } = await seedConversation(productId);

    const client = new ScriptedModelClient({
      script: [
        {
          toolName: "api_updateBillingAddress",
          toolInput: {
            intent: "Change the postcode.",
            accountId: SEED_ACCOUNT_ID,
            line1: "18 Harbour Road",
            line2: null,
            city: "Bristol",
            postal_code: "ZZ1 1ZZ",
            country: "GB",
          },
        },
      ],
    });

    const execute = createTurnExecutor({
      env: testEnvironment({ SG_STEP_BUDGET: "4" }),
      logger: pino({ level: "silent" }),
      db: database.db,
      ephemeral: new EphemeralBus(),
      pendingCalls: new PendingCalls(),
      confirmations: new ConfirmationRegistry(),
      modelClient: client,
      procedureMatcher: new NoProcedureMatcher(),
      knowledgeRetriever: new NoKnowledgeRetriever(),
      taskVerifier: new NoTaskVerifier(),
      escalationSink: new NoEscalationSink(),
    });

    const outcome = await execute({
      productId,
      conversationId,
      turnId: randomUUID(),
      identity: {
        tier: "anonymous",
        endUserId,
        externalId: null,
        scopes: [],
        claims: {},
      },
      userMessage: "Change our postcode to ZZ1 1ZZ.",
      digest: null,
      url: "https://app.example/settings/billing",
      requestId: "req-anon",
      signal: new AbortController().signal,
    });

    expect(outcome.resolutionState).toBe("escalated");
    expect(fixture.state.accounts.get(SEED_ACCOUNT_ID)?.billing_address.postal_code).toBe(before);

    const entries = await withProduct(database.db, productId, (tx) =>
      readJournalSince(tx, conversationId, 0),
    );
    const steps = entries.flatMap((entry) => (entry.kind === "step" ? [entry.step] : []));
    expect(steps).toHaveLength(1);
    expect(steps[0]?.policyVerdict).toEqual({
      decision: "block",
      reason: "identity_insufficient",
    });
    expect(steps[0]?.result.status).toBe("not_executed");
    expect(steps[0]?.expectOutcome.satisfied).toBe(false);
  });
});
