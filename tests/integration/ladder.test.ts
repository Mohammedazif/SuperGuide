import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pino } from "pino";
import pg from "pg";
import { createDatabase, withProduct, type DatabaseHandle } from "../../apps/control-plane/src/db/client.js";
import { readJournalSince } from "../../apps/control-plane/src/repository/journal.js";
import { createTurnExecutor } from "../../apps/control-plane/src/turn/loop.js";
import { ScriptedModelClient } from "../../apps/control-plane/src/model/scripted-client.js";
import { ModelProcedureMatcher } from "../../apps/control-plane/src/turn/procedure-matcher.js";
import { ApiTaskVerifier } from "../../apps/control-plane/src/turn/task-verifier.js";
import { NoKnowledgeRetriever, NoProcedureMatcher, NoTaskVerifier } from "../../apps/control-plane/src/turn/ports.js";
import { EphemeralBus } from "../../apps/control-plane/src/events/ephemeral.js";
import { PendingCalls } from "../../apps/control-plane/src/turn/pending-calls.js";
import { ConfirmationRegistry } from "../../apps/control-plane/src/turn/confirmations.js";
import { SEED_ACCOUNT_ID } from "../../apps/fixture-app/src/data.js";
import { createTestProduct, testEnvironment } from "../helpers/server.js";
import {
  enableCapability,
  ingestFixtureTools,
  insertProcedure,
  startFixtureApp,
  type RunningFixture,
} from "../helpers/fixture.js";
import { simulateBrowser } from "../helpers/browser.js";
import { appDatabaseUrl, migrationDatabaseUrl } from "../helpers/database.js";
import { loadProcedure } from "@superguide/procedures";

const BILLING_PROCEDURE = `
id: update_billing_address
version: 1
title: Update the billing address
when: user wants to change billing or invoice address
preconditions:
  - user.verified
steps:
  - prefer_api:
      operation: updateBillingAddress
      params:
        accountId: "{{params.accountId}}"
policy:
  never: [delete_account]
  confirm: []
  escalate_if: []
success:
  - api:
      operation: getAccount
      params:
        accountId: "{{params.accountId}}"
      json_path: $.billing_address.postal_code
      equals: "{{params.postal_code}}"
`;

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

describe("the execution ladder", () => {
  let fixture: RunningFixture;
  let database: DatabaseHandle;
  let productId: string;

  beforeAll(async () => {
    fixture = await startFixtureApp();
    database = createDatabase(appDatabaseUrl(), 5);
    ({ productId } = await createTestProduct());
    await ingestFixtureTools({ productId, apiBaseUrl: fixture.baseUrl });
    await enableCapability(
      productId,
      "export_invoices",
      "read",
      { properties: { format: { type: "string" } }, required: ["format"] },
      "Download the invoice history in the browser.",
    );
  });

  afterAll(async () => {
    await database.close();
    await fixture.close();
  });

  interface Rig {
    execute: ReturnType<typeof createTurnExecutor>;
    ephemeral: EphemeralBus;
    pendingCalls: PendingCalls;
    confirmations: ConfirmationRegistry;
  }

  function rig(client: ScriptedModelClient, withProcedure: boolean): Rig {
    const ephemeral = new EphemeralBus();
    const pendingCalls = new PendingCalls();
    const confirmations = new ConfirmationRegistry();
    const logger = pino({ level: "silent" });

    return {
      ephemeral,
      pendingCalls,
      confirmations,
      execute: createTurnExecutor({
        env: testEnvironment({ SG_STEP_BUDGET: "6" }),
        logger,
        db: database.db,
        ephemeral,
        pendingCalls,
        confirmations,
        modelClient: client,
        procedureMatcher: withProcedure
          ? new ModelProcedureMatcher(client, logger)
          : new NoProcedureMatcher(),
        knowledgeRetriever: new NoKnowledgeRetriever(),
        taskVerifier: withProcedure ? new ApiTaskVerifier() : new NoTaskVerifier(),
      }),
    };
  }

  function approve(rigged: Rig, conversationId: string): void {
    rigged.ephemeral.subscribe(conversationId, (event) => {
      if (event.event !== "action.confirm") return;
      setTimeout(() => {
        rigged.confirmations.decide(conversationId, event.toolCallId, event.paramsHash, "approved");
      }, 0);
    });
  }

  it("level one finishes a task through the customer's API with a satisfied predicate", async () => {
    fixture.reset();
    const { conversationId, endUserId } = await seedConversation(productId);

    const client = new ScriptedModelClient({
      script: [
        {
          toolName: "api_getSsoSettings",
          toolInput: { intent: "Read the sign-on settings.", accountId: SEED_ACCOUNT_ID },
        },
        {
          toolName: "finish",
          toolInput: {
            intent: "Report.",
            summary: "Single sign-on is currently off.",
            resolutionState: "resolved",
          },
        },
      ],
    });

    const rigged = rig(client, false);
    const outcome = await rigged.execute({
      productId,
      conversationId,
      turnId: randomUUID(),
      identity: { tier: "verified", endUserId, externalId: "dana", scopes: [], claims: {} },
      userMessage: "Is single sign-on turned on?",
      digest: null,
      url: "https://app.example/settings/sso",
      requestId: "req-l1",
      signal: new AbortController().signal,
    });

    expect(outcome.resolutionState).toBe("resolved");
    const steps = await readSteps(conversationId);
    expect(steps).toHaveLength(1);
    expect(steps[0]?.ladderLevel).toBe("L1");
    expect(steps[0]?.expectOutcome.satisfied).toBe(true);
    expect(steps[0]?.expectOutcome.evaluatedBy).toBe("rules");
  });

  it("level two finishes a task through a declared client capability", async () => {
    fixture.reset();
    const { conversationId, endUserId } = await seedConversation(productId);

    const client = new ScriptedModelClient({
      script: [
        {
          toolName: "capability_export_invoices",
          toolInput: { intent: "Export the invoice history.", format: "csv" },
        },
        {
          toolName: "finish",
          toolInput: {
            intent: "Report.",
            summary: "Your invoice history has been downloaded.",
            resolutionState: "resolved",
          },
        },
      ],
    });

    const rigged = rig(client, false);
    const browser = simulateBrowser(
      rigged.ephemeral,
      rigged.pendingCalls,
      conversationId,
      () => ({
        status: "ok",
        data: { downloaded: true, rows: 3 },
        digest: null,
        url: "https://app.example/invoices",
      }),
    );

    const outcome = await rigged.execute({
      productId,
      conversationId,
      turnId: randomUUID(),
      identity: { tier: "verified", endUserId, externalId: "dana", scopes: [], claims: {} },
      userMessage: "Download all our invoices.",
      digest: null,
      url: "https://app.example/invoices",
      requestId: "req-l2",
      signal: new AbortController().signal,
    });
    browser.stop();

    expect(outcome.resolutionState).toBe("resolved");
    expect(browser.dispatched).toHaveLength(1);
    expect(browser.dispatched[0]?.type).toBe("invoke_capability");

    const steps = await readSteps(conversationId);
    expect(steps).toHaveLength(1);
    expect(steps[0]?.ladderLevel).toBe("L2");
    expect(steps[0]?.expectOutcome.satisfied).toBe(true);
  });

  it("level three finishes a task by navigating a route", async () => {
    fixture.reset();
    const { conversationId, endUserId } = await seedConversation(productId);

    const client = new ScriptedModelClient({
      script: [
        {
          toolName: "navigate_billing_settings",
          toolInput: { intent: "Take you to billing settings." },
        },
        {
          toolName: "finish",
          toolInput: {
            intent: "Report.",
            summary: "You are on the billing settings page now.",
            resolutionState: "resolved",
          },
        },
      ],
    });

    const rigged = rig(client, false);
    const browser = simulateBrowser(
      rigged.ephemeral,
      rigged.pendingCalls,
      conversationId,
      () => ({
        status: "ok",
        data: { navigated: true },
        digest: null,
        url: "https://app.example/settings/billing",
      }),
    );

    const outcome = await rigged.execute({
      productId,
      conversationId,
      turnId: randomUUID(),
      identity: { tier: "verified", endUserId, externalId: "dana", scopes: [], claims: {} },
      userMessage: "Where do I change our billing details?",
      digest: null,
      url: "https://app.example/account",
      requestId: "req-l3",
      signal: new AbortController().signal,
    });
    browser.stop();

    expect(outcome.resolutionState).toBe("resolved");
    expect(browser.dispatched[0]?.type).toBe("navigate_route");

    const steps = await readSteps(conversationId);
    expect(steps).toHaveLength(1);
    expect(steps[0]?.ladderLevel).toBe("L3");
    expect(steps[0]?.expectOutcome.satisfied).toBe(true);
    expect(steps[0]?.expectOutcome.detail).toMatch(/matches/);
  });

  it("level five asks one question and leaves the conversation open", async () => {
    fixture.reset();
    const { conversationId, endUserId } = await seedConversation(productId);

    const client = new ScriptedModelClient({
      script: [
        {
          toolName: "ask_user",
          toolInput: {
            intent: "Find out which address they mean.",
            question: "Which address should I change, the billing one or the postal one?",
          },
        },
      ],
    });

    const outcome = await rig(client, false).execute({
      productId,
      conversationId,
      turnId: randomUUID(),
      identity: { tier: "verified", endUserId, externalId: "dana", scopes: [], claims: {} },
      userMessage: "Change our address.",
      digest: null,
      url: "https://app.example/account",
      requestId: "req-l5",
      signal: new AbortController().signal,
    });

    expect(outcome.resolutionState).toBe("in_progress");
    expect(outcome.closeConversation).toBe(false);
    expect(outcome.summary).toMatch(/which address/i);

    const steps = await readSteps(conversationId);
    expect(steps[0]?.ladderLevel).toBe("L5");
  });

  it("level six hands over with the trajectory rather than guessing", async () => {
    fixture.reset();
    const { conversationId, endUserId } = await seedConversation(productId);

    const client = new ScriptedModelClient({
      script: [
        {
          toolName: "escalate",
          toolInput: {
            intent: "Hand this to a person.",
            reason: "no_matching_capability",
            summary: "There is no way to change a company registration number from here.",
          },
        },
      ],
    });

    const outcome = await rig(client, false).execute({
      productId,
      conversationId,
      turnId: randomUUID(),
      identity: { tier: "verified", endUserId, externalId: "dana", scopes: [], claims: {} },
      userMessage: "Change our company registration number.",
      digest: null,
      url: "https://app.example/account",
      requestId: "req-l6",
      signal: new AbortController().signal,
    });

    expect(outcome.resolutionState).toBe("escalated");
    const steps = await readSteps(conversationId);
    expect(steps[0]?.ladderLevel).toBe("L6");
    expect(steps[0]?.expectOutcome.satisfied).toBe(false);
  });

  it("an induced failure produces an escalation rather than a completion claim", async () => {
    fixture.reset();
    const loaded = loadProcedure(BILLING_PROCEDURE);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    const scopedProduct = await createTestProduct();
    await ingestFixtureTools({ productId: scopedProduct.productId, apiBaseUrl: fixture.baseUrl });
    await insertProcedure(
      scopedProduct.productId,
      "update_billing_address",
      BILLING_PROCEDURE,
      loaded.procedure.document,
    );

    const { conversationId, endUserId } = await seedConversation(scopedProduct.productId);
    const before = fixture.state.accounts.get(SEED_ACCOUNT_ID)?.billing_address.postal_code;

    const client = new ScriptedModelClient({
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
            country: "GBR",
          },
        },
        {
          toolName: "finish",
          toolInput: {
            intent: "Report.",
            summary: "All done, your postcode is updated.",
            resolutionState: "resolved",
          },
        },
      ],
    });

    const rigged = rig(client, true);
    approve(rigged, conversationId);

    const outcome = await rigged.execute({
      productId: scopedProduct.productId,
      conversationId,
      turnId: randomUUID(),
      identity: { tier: "verified", endUserId, externalId: "dana", scopes: [], claims: {} },
      userMessage: "Change our billing postcode to EH3 9DR.",
      digest: null,
      url: "https://app.example/settings/billing",
      requestId: "req-induced",
      signal: new AbortController().signal,
    });

    expect(outcome.resolutionState).toBe("escalated");
    expect(outcome.summary).toMatch(/could not confirm/i);
    expect(fixture.state.accounts.get(SEED_ACCOUNT_ID)?.billing_address.postal_code).toBe(before);

    const steps = await readSteps(conversationId, scopedProduct.productId);
    expect(steps[0]?.expectOutcome.satisfied).toBe(false);
    expect(steps[0]?.result.status).toBe("failed");
  });

  async function readSteps(conversationId: string, scoped = productId) {
    const entries = await withProduct(database.db, scoped, (tx) =>
      readJournalSince(tx, conversationId, 0),
    );
    return entries.flatMap((entry) => (entry.kind === "step" ? [entry.step] : []));
  }
});
