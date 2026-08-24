import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pino } from "pino";
import pg from "pg";
import { createDatabase, withProduct, type DatabaseHandle } from "../../apps/control-plane/src/db/client.js";
import { readJournalSince } from "../../apps/control-plane/src/repository/journal.js";
import { createTurnExecutor } from "../../apps/control-plane/src/turn/loop.js";
import { ScriptedModelClient } from "../../apps/control-plane/src/model/scripted-client.js";
import { NoKnowledgeRetriever, NoProcedureMatcher, NoTaskVerifier } from "../../apps/control-plane/src/turn/ports.js";
import { NoEscalationSink } from "../../apps/control-plane/src/escalation/sink.js";
import { EphemeralBus } from "../../apps/control-plane/src/events/ephemeral.js";
import { PendingCalls } from "../../apps/control-plane/src/turn/pending-calls.js";
import { ConfirmationRegistry } from "../../apps/control-plane/src/turn/confirmations.js";
import { compileTools } from "../../apps/control-plane/src/tools/compile.js";
import { loadTurnContext } from "../../apps/control-plane/src/turn/context.js";
import { createTestProduct, testEnvironment } from "../helpers/server.js";
import { ingestFixtureTools, startFixtureApp, type RunningFixture } from "../helpers/fixture.js";
import { simulateBrowser } from "../helpers/browser.js";
import { appDatabaseUrl, migrationDatabaseUrl } from "../helpers/database.js";

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

async function setProductFlag(productId: string, enabled: boolean): Promise<void> {
  const client = new pg.Client({ connectionString: migrationDatabaseUrl() });
  await client.connect();
  try {
    await client.query("UPDATE product SET grounded_actions_enabled = $1 WHERE id = $2", [
      enabled,
      productId,
    ]);
  } finally {
    await client.end();
  }
}

describe("grounded actions behind the flag", () => {
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

  async function compiledNames(globalFlag: boolean, productFlag: boolean): Promise<string[]> {
    await setProductFlag(productId, productFlag);
    const loaded = await withProduct(database.db, productId, (tx) =>
      loadTurnContext(tx, productId, randomUUID()),
    );
    return compileTools({
      product: loaded.product,
      tools: loaded.tools,
      groundedActionsEnabled: globalFlag && loaded.product.groundedActionsEnabled,
    }).map((tool) => tool.name);
  }

  it("compiles no grounded tool unless both the global switch and the product agree", async () => {
    expect((await compiledNames(false, false)).filter((n) => n.startsWith("ui_"))).toEqual([]);
    expect((await compiledNames(true, false)).filter((n) => n.startsWith("ui_"))).toEqual([]);
    expect((await compiledNames(false, true)).filter((n) => n.startsWith("ui_"))).toEqual([]);

    const both = (await compiledNames(true, true)).filter((n) => n.startsWith("ui_"));
    expect(both).toContain("ui_click");
    expect(both).toContain("ui_set_value");
    expect(both).not.toContain("ui_navigate_route");
    expect(both).not.toContain("ui_invoke_capability");
  });

  it("makes a grounded action unreachable when the flag is off", async () => {
    await setProductFlag(productId, false);
    const { conversationId, endUserId } = await seedConversation(productId);

    const client = new ScriptedModelClient({
      script: [{ toolName: "ui_click", toolInput: { intent: "Click save.", ref: "e1" } }],
    });

    const rigged = {
      ephemeral: new EphemeralBus(),
      pendingCalls: new PendingCalls(),
    };

    const browser = simulateBrowser(rigged.ephemeral, rigged.pendingCalls, conversationId, () => ({
      status: "ok",
      data: { clicked: true },
      digest: null,
      url: "https://app.example/account",
    }));

    await expect(
      createTurnExecutor({
        env: testEnvironment({ SG_ENABLE_GROUNDED_ACTIONS: "false", SG_STEP_BUDGET: "4" }),
        logger: pino({ level: "silent" }),
        db: database.db,
        ephemeral: rigged.ephemeral,
        pendingCalls: rigged.pendingCalls,
        confirmations: new ConfirmationRegistry(),
        modelClient: client,
        procedureMatcher: new NoProcedureMatcher(),
        knowledgeRetriever: new NoKnowledgeRetriever(),
        taskVerifier: new NoTaskVerifier(),
      escalationSink: new NoEscalationSink(),
      })({
        productId,
        conversationId,
        turnId: randomUUID(),
        identity: { tier: "verified", endUserId, externalId: "dana", scopes: [], claims: {} },
        userMessage: "Click the save button for me.",
        digest: null,
        url: "https://app.example/account",
        requestId: "req-flag-off",
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/not in the compiled vocabulary/);

    browser.stop();
    expect(browser.dispatched).toEqual([]);
  });

  it("completes a task only the interface can reach when the flag is on", async () => {
    await setProductFlag(productId, true);
    const { conversationId, endUserId } = await seedConversation(productId);

    const client = new ScriptedModelClient({
      script: [
        {
          toolName: "ui_set_value",
          toolInput: {
            intent: "Type the registration number into the field.",
            ref: "e1234",
            value: "SC441122",
          },
        },
        {
          toolName: "ui_click",
          toolInput: { intent: "Save the registration number.", ref: "e5678" },
        },
        {
          toolName: "finish",
          toolInput: {
            intent: "Report.",
            summary: "Your company registration number is saved.",
            resolutionState: "resolved",
          },
        },
      ],
    });

    const ephemeral = new EphemeralBus();
    const pendingCalls = new PendingCalls();

    const browser = simulateBrowser(ephemeral, pendingCalls, conversationId, (action) => ({
      status: "ok",
      data: { performed: action.type },
      digest: {
        url: "https://app.example/account",
        title: "Account",
        headings: ["Account"],
        landmarks: ["main"],
        elements: [
          {
            ref: "e5678",
            role: "button",
            name: "Save registration",
            inViewport: true,
          },
          ...(action.type === "click"
            ? [{ ref: "e9999", role: "status", name: "Saved", inViewport: true }]
            : []),
        ],
        truncated: false,
      },
      url: "https://app.example/account",
    }));

    const outcome = await createTurnExecutor({
      env: testEnvironment({ SG_ENABLE_GROUNDED_ACTIONS: "true", SG_STEP_BUDGET: "6" }),
      logger: pino({ level: "silent" }),
      db: database.db,
      ephemeral,
      pendingCalls,
      confirmations: (() => {
        const registry = new ConfirmationRegistry();
        ephemeral.subscribe(conversationId, (event) => {
          if (event.event !== "action.confirm") return;
          setTimeout(() => {
            registry.decide(conversationId, event.toolCallId, event.paramsHash, "approved");
          }, 0);
        });
        return registry;
      })(),
      modelClient: client,
      procedureMatcher: new NoProcedureMatcher(),
      knowledgeRetriever: new NoKnowledgeRetriever(),
      taskVerifier: new NoTaskVerifier(),
      escalationSink: new NoEscalationSink(),
    })({
      productId,
      conversationId,
      turnId: randomUUID(),
      identity: { tier: "verified", endUserId, externalId: "dana", scopes: [], claims: {} },
      userMessage: "Set our company registration number to SC441122.",
      digest: null,
      url: "https://app.example/account",
      requestId: "req-flag-on",
      signal: new AbortController().signal,
    });
    browser.stop();

    expect(outcome.resolutionState).toBe("resolved");
    expect(browser.dispatched.map((action) => action.type)).toEqual(["set_value", "click"]);

    const entries = await withProduct(database.db, productId, (tx) =>
      readJournalSince(tx, conversationId, 0),
    );
    const steps = entries.flatMap((entry) => (entry.kind === "step" ? [entry.step] : []));
    expect(steps).toHaveLength(2);
    for (const step of steps) {
      expect(step.ladderLevel).toBe("L4");
      expect(step.expectOutcome.satisfied).toBe(true);
    }
  });
});
