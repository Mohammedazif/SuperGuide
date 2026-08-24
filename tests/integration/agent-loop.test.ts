import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pino } from "pino";
import { withProduct } from "../../apps/control-plane/src/db/client.js";
import { readJournalSince } from "../../apps/control-plane/src/repository/journal.js";
import { createTurnExecutor } from "../../apps/control-plane/src/turn/loop.js";
import { ScriptedModelClient } from "../../apps/control-plane/src/model/scripted-client.js";
import {
  NoKnowledgeRetriever,
  NoProcedureMatcher,
  NoTaskVerifier,
} from "../../apps/control-plane/src/turn/ports.js";
import { NoEscalationSink } from "../../apps/control-plane/src/escalation/sink.js";
import { EphemeralBus } from "../../apps/control-plane/src/events/ephemeral.js";
import { PendingCalls } from "../../apps/control-plane/src/turn/pending-calls.js";
import { ConfirmationRegistry } from "../../apps/control-plane/src/turn/confirmations.js";
import { createDatabase, type DatabaseHandle } from "../../apps/control-plane/src/db/client.js";
import { SEED_ACCOUNT_ID } from "../../apps/fixture-app/src/data.js";
import { createTestProduct, testEnvironment } from "../helpers/server.js";
import { ingestFixtureTools, startFixtureApp, type RunningFixture } from "../helpers/fixture.js";
import { appDatabaseUrl } from "../helpers/database.js";
import pg from "pg";
import { randomUUID } from "node:crypto";

const NEW_POSTAL_CODE = "EH3 9DR";

async function seedConversation(
  database: DatabaseHandle,
  productId: string,
): Promise<{ conversationId: string; endUserId: string }> {
  const client = new pg.Client({ connectionString: process.env["SG_MIGRATION_DATABASE_URL"] });
  await client.connect();
  try {
    const endUser = await client.query<{ id: string }>(
      "INSERT INTO end_user (product_id, external_id, identity_tier, scopes) VALUES ($1, $2, 'verified', $3) RETURNING id",
      [productId, `user-${randomUUID()}`, ["billing:write"]],
    );
    const endUserId = endUser.rows[0]?.id;
    if (endUserId === undefined) throw new Error("no end user");

    const conversation = await client.query<{ id: string }>(
      "INSERT INTO conversation (product_id, end_user_id, status, resolution_state) VALUES ($1, $2, 'open', 'in_progress') RETURNING id",
      [productId, endUserId],
    );
    const conversationId = conversation.rows[0]?.id;
    if (conversationId === undefined) throw new Error("no conversation");
    void database;
    return { conversationId, endUserId };
  } finally {
    await client.end();
  }
}

describe("the agent loop against the fixture application", () => {
  let fixture: RunningFixture;
  let database: DatabaseHandle;
  let productId: string;

  beforeAll(async () => {
    fixture = await startFixtureApp();
    database = createDatabase(appDatabaseUrl(), 5);
    ({ productId } = await createTestProduct());
    await ingestFixtureTools({
      productId,
      apiBaseUrl: fixture.baseUrl,
      credentialsKey: Buffer.alloc(32, 9),
    });
  });

  afterAll(async () => {
    await database.close();
    await fixture.close();
  });

  interface Harnessed {
    execute: ReturnType<typeof createTurnExecutor>;
    confirmations: ConfirmationRegistry;
    ephemeral: EphemeralBus;
    confirmed: { toolCallId: string; paramsHash: string }[];
  }

  function buildExecutor(client: ScriptedModelClient): Harnessed {
    const env = testEnvironment({ SG_STEP_BUDGET: "6" });
    const ephemeral = new EphemeralBus();
    const confirmations = new ConfirmationRegistry();
    const confirmed: { toolCallId: string; paramsHash: string }[] = [];

    const execute = createTurnExecutor({
      env,
      logger: pino({ level: "silent" }),
      db: database.db,
      ephemeral,
      pendingCalls: new PendingCalls(),
      confirmations,
      modelClient: client,
      procedureMatcher: new NoProcedureMatcher(),
      knowledgeRetriever: new NoKnowledgeRetriever(),
      taskVerifier: new NoTaskVerifier(),
      escalationSink: new NoEscalationSink(),
    });

    return { execute, confirmations, ephemeral, confirmed };
  }

  function approveConfirmations(harnessed: Harnessed, conversationId: string): void {
    harnessed.ephemeral.subscribe(conversationId, (event) => {
      if (event.event !== "action.confirm") return;
      harnessed.confirmed.push({
        toolCallId: event.toolCallId,
        paramsHash: event.paramsHash,
      });
      setTimeout(() => {
        harnessed.confirmations.decide(
          conversationId,
          event.toolCallId,
          event.paramsHash,
          "approved",
        );
      }, 0);
    });
  }

  it("finishes a real task, writes every step, and reads the cache on the second turn", async () => {
    fixture.reset();
    const { conversationId, endUserId } = await seedConversation(database, productId);

    const client = new ScriptedModelClient({
      script: [
        {
          text: "Let me read the account first.",
          toolName: "api_getAccount",
          toolInput: { intent: "Read the current billing address.", accountId: SEED_ACCOUNT_ID },
        },
        {
          text: "Now I will update the postal code.",
          toolName: "api_updateBillingAddress",
          toolInput: {
            intent: "Change the postal code on the billing address.",
            accountId: SEED_ACCOUNT_ID,
            line1: "18 Harbour Road",
            line2: null,
            city: "Bristol",
            postal_code: NEW_POSTAL_CODE,
            country: "GB",
          },
        },
        {
          text: "Checking the change landed.",
          toolName: "api_getAccount",
          toolInput: { intent: "Confirm the postal code changed.", accountId: SEED_ACCOUNT_ID },
        },
        {
          toolName: "finish",
          toolInput: {
            intent: "Report the result.",
            summary: `Your billing postcode is now ${NEW_POSTAL_CODE}.`,
            resolutionState: "resolved",
          },
        },
      ],
    });

    const harnessed = buildExecutor(client);
    approveConfirmations(harnessed, conversationId);
    const outcome = await harnessed.execute({
      productId,
      conversationId,
      turnId: "11111111-1111-4111-8111-111111111111",
      identity: {
        tier: "verified",
        endUserId,
        externalId: "dana",
        scopes: ["billing:write"],
        claims: {},
      },
      userMessage: `Please change our billing postcode to ${NEW_POSTAL_CODE}.`,
      digest: null,
      url: "https://app.example/settings/billing",
      requestId: "req-loop-1",
      signal: new AbortController().signal,
    });

    expect(outcome.resolutionState).toBe("resolved");
    expect(outcome.summary).toContain(NEW_POSTAL_CODE);

    const account = fixture.state.accounts.get(SEED_ACCOUNT_ID);
    expect(account?.billing_address.postal_code).toBe(NEW_POSTAL_CODE);

    const entries = await withProduct(database.db, productId, (tx) =>
      readJournalSince(tx, conversationId, 0),
    );
    const steps = entries.flatMap((entry) => (entry.kind === "step" ? [entry.step] : []));
    expect(steps).toHaveLength(3);

    for (const step of steps) {
      expect(step.expectOutcome.satisfied).toBe(true);
      expect(step.ladderLevel).toBe("L1");
      expect(step.requestId).toBe("req-loop-1");
      expect(step.model).toBe("claude-opus-5");
      expect(step.policyVerdict.decision).toBe(step.action.risk === "read" ? "allow" : "confirm");
    }

    const cacheReads = steps.map((step) => step.cacheReadTokens);
    expect(cacheReads[0]).toBe(0);
    expect(cacheReads[1]).toBeGreaterThan(0);
    expect(cacheReads[2]).toBeGreaterThan(0);

    expect(harnessed.confirmed).toHaveLength(1);
    expect(harnessed.confirmed[0]?.paramsHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("keeps the cached prefix byte identical across every call in a turn", async () => {
    fixture.reset();
    const { conversationId, endUserId } = await seedConversation(database, productId);

    const client = new ScriptedModelClient({
      script: [
        {
          toolName: "api_getAccount",
          toolInput: { intent: "Read the account.", accountId: SEED_ACCOUNT_ID },
        },
        {
          toolName: "api_getSsoSettings",
          toolInput: { intent: "Read the sign-on settings.", accountId: SEED_ACCOUNT_ID },
        },
        {
          toolName: "finish",
          toolInput: { intent: "Report.", summary: "Read both.", resolutionState: "resolved" },
        },
      ],
    });

    await buildExecutor(client).execute({
      productId,
      conversationId,
      turnId: "22222222-2222-4222-8222-222222222222",
      identity: {
        tier: "verified",
        endUserId,
        externalId: "dana",
        scopes: [],
        claims: {},
      },
      userMessage: "Is single sign-on on?",
      digest: null,
      url: "https://app.example/invoices",
      requestId: "req-loop-2",
      signal: new AbortController().signal,
    });

    expect(client.requests.length).toBe(3);
    const prefixes = client.requests.map((request) =>
      JSON.stringify({ system: request.system, tools: request.tools }),
    );
    expect(prefixes[1]).toBe(prefixes[0]);
    expect(prefixes[2]).toBe(prefixes[0]);
  });

  it("escalates honestly when the step budget runs out instead of claiming success", async () => {
    fixture.reset();
    const { conversationId, endUserId } = await seedConversation(database, productId);

    const client = new ScriptedModelClient({
      script: Array.from({ length: 8 }, () => ({
        toolName: "api_getAccount",
        toolInput: { intent: "Read the account again.", accountId: SEED_ACCOUNT_ID },
      })),
    });

    const outcome = await buildExecutor(client).execute({
      productId,
      conversationId,
      turnId: "33333333-3333-4333-8333-333333333333",
      identity: {
        tier: "verified",
        endUserId,
        externalId: "dana",
        scopes: [],
        claims: {},
      },
      userMessage: "Loop forever please.",
      digest: null,
      url: "https://app.example/account",
      requestId: "req-loop-3",
      signal: new AbortController().signal,
    });

    expect(outcome.resolutionState).toBe("escalated");
    expect(outcome.summary).toMatch(/more steps than it is allowed/i);

    const entries = await withProduct(database.db, productId, (tx) =>
      readJournalSince(tx, conversationId, 0),
    );
    expect(entries.filter((entry) => entry.kind === "step")).toHaveLength(6);
  });

  it("never writes a credential, an authorization value, or a cookie into a step", async () => {
    fixture.reset();
    const { conversationId, endUserId } = await seedConversation(database, productId);

    const client = new ScriptedModelClient({
      script: [
        {
          toolName: "api_getAccount",
          toolInput: { intent: "Read the account.", accountId: SEED_ACCOUNT_ID },
        },
        {
          toolName: "finish",
          toolInput: { intent: "Report.", summary: "Read it.", resolutionState: "resolved" },
        },
      ],
    });

    await buildExecutor(client).execute({
      productId,
      conversationId,
      turnId: "44444444-4444-4444-8444-444444444444",
      identity: {
        tier: "verified",
        endUserId,
        externalId: "dana",
        scopes: [],
        claims: {},
      },
      userMessage: "Show me the account.",
      digest: null,
      url: "https://app.example/account",
      requestId: "req-loop-4",
      signal: new AbortController().signal,
    });

    const entries = await withProduct(database.db, productId, (tx) =>
      readJournalSince(tx, conversationId, 0),
    );
    const serialised = JSON.stringify(entries);
    expect(serialised).not.toContain("fixture-secret-token-value-do-not-log");
    expect(serialised.toLowerCase()).not.toContain("bearer ");
    expect(serialised.toLowerCase()).not.toContain("set-cookie");
  });
});
