import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  BetaContentBlockParam,
  BetaMessage,
  BetaMessageParam,
  BetaToolUseBlockParam,
} from "@anthropic-ai/sdk/resources/beta/messages";
import type { GrantTier, PageDigest, TurnEvent } from "@superguide/contract/anywhere";
import { TurnAgent } from "../../apps/control-plane/src/anywhere/agent/loop.js";
import { TurnStore } from "../../apps/control-plane/src/anywhere/store.js";
import { QuotaService } from "../../apps/control-plane/src/anywhere/quota.js";
import { turnEventSchema } from "@superguide/contract/anywhere";
import {
  startHarness,
  TEST_EXTENSION_ORIGIN,
  type TestHarness,
} from "../helpers/server.js";

let harness: TestHarness;
let token: string;
let deviceId: string;
const scripts = new Map<string, BetaMessage[]>();

function modelMessage(
  content: BetaContentBlockParam[],
  stopReason: BetaMessage["stop_reason"],
): BetaMessage {
  return {
    id: `msg_${randomUUID()}`,
    type: "message",
    role: "assistant",
    model: "claude-opus-5",
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      input_tokens: 100,
      output_tokens: 10,
    },
  } as BetaMessage;
}

function toolUse(name: string, input: unknown): BetaToolUseBlockParam {
  return { type: "tool_use", id: `toolu_${randomUUID()}`, name, input };
}

function taskTextOf(messages: BetaMessageParam[] | undefined): string {
  const first = messages?.[0];
  const content = typeof first?.content === "string" ? first.content : "";
  const match = /^Task from the person: (.*)$/m.exec(content);
  if (match?.[1] === undefined) throw new Error("no task text in the first message");
  return match[1];
}

const digest: PageDigest = {
  url: "http://127.0.0.1:1/billing",
  title: "Billing",
  nodes: [
    {
      id: "e00000001",
      parentId: null,
      role: "heading",
      name: "Billing settings",
      state: { disabled: false },
      headingLevel: 1,
      inViewport: true,
    },
    {
      id: "e00000002",
      parentId: null,
      role: "textbox",
      name: "Contact email",
      state: { disabled: false },
      inViewport: true,
    },
  ],
};

async function api(path: string, body: unknown): Promise<Response> {
  return fetch(`${harness.baseUrl}${path}`, {
    method: "POST",
    headers: {
      origin: TEST_EXTENSION_ORIGIN,
      "content-type": "application/json",
      "x-sga-device-token": token,
    },
    body: JSON.stringify(body),
  });
}

async function startTask(taskText: string, tier: GrantTier = "control"): Promise<string> {
  const response = await api("/v1/anywhere/task", {
    origin: "http://127.0.0.1:1",
    url: digest.url,
    tier,
    taskText,
    digest,
    adapterSetVersion: null,
  });
  expect(response.status).toBe(202);
  return ((await response.json()) as { turnId: string }).turnId;
}

async function eventually<T>(probe: () => Promise<T | null>, what: string): Promise<T> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const found = await probe();
    if (found !== null) return found;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function events(turnId: string): Promise<TurnEvent[]> {
  const rows = await harness.database.pool.query<{ payload: unknown }>(
    "SELECT payload FROM turn_event WHERE turn_id = $1 ORDER BY seq",
    [turnId],
  );
  return rows.rows.map((row) => turnEventSchema.parse(row.payload));
}

async function awaitEvent<K extends TurnEvent["kind"]>(
  turnId: string,
  kind: K,
  where: (event: Extract<TurnEvent, { kind: K }>) => boolean = () => true,
): Promise<Extract<TurnEvent, { kind: K }>> {
  return eventually(async () => {
    const all = await events(turnId);
    const match = all.find(
      (event): event is Extract<TurnEvent, { kind: K }> =>
        event.kind === kind && where(event as Extract<TurnEvent, { kind: K }>),
    );
    return match ?? null;
  }, `${kind} event on ${turnId}`);
}

async function turnStatus(turnId: string): Promise<string> {
  const rows = await harness.database.pool.query<{ status: string }>(
    "SELECT status FROM turn WHERE id = $1",
    [turnId],
  );
  return rows.rows[0]?.status ?? "missing";
}

async function awaitTurnStatus(turnId: string, status: string): Promise<void> {
  await eventually(
    async () => ((await turnStatus(turnId)) === status ? true : null),
    `turn ${turnId} to become ${status}`,
  );
}

async function trajectoryKinds(turnId: string): Promise<string[]> {
  const rows = await harness.database.pool.query<{ kind: string }>(
    "SELECT kind FROM trajectory WHERE turn_id = $1 ORDER BY seq",
    [turnId],
  );
  return rows.rows.map((row) => row.kind);
}

async function usedToday(): Promise<number> {
  const rows = await harness.database.pool.query<{ used: number }>(
    "SELECT COALESCE(SUM(used), 0)::int AS used FROM device_usage WHERE device_id = $1",
    [deviceId],
  );
  return rows.rows[0]?.used ?? 0;
}

async function deliverResult(
  turnId: string,
  actionId: string,
  freshDigest: PageDigest = digest,
): Promise<void> {
  const response = await api("/v1/anywhere/action-result", {
    turnId,
    actionId,
    result: {
      status: "completed",
      delta: { added: [], removed: [], changed: [], urlChanged: null, titleChanged: null },
    },
    digest: freshDigest,
  });
  expect(response.status).toBe(204);
}

beforeAll(async () => {
  harness = await startHarness({
    env: { SG_STEP_BUDGET: "3" },
    makeAnywhereAgent: ({ env, pool }) =>
      new TurnAgent({
        env,
        pool,
        store: new TurnStore(pool),
        quotas: new QuotaService(pool, env),
        plan: (request) => {
          const script = scripts.get(taskTextOf(request.messages));
          const next = script?.shift();
          if (next === undefined) throw new Error("the test script is out of responses");
          return Promise.resolve(next);
        },
        scan: () => Promise.resolve({ suspicious: false, findings: [] }),
        waits: { resultTimeoutMs: 8000, confirmTimeoutMs: 8000, pollMs: 50 },
      }),
  });
  deviceId = randomUUID();
  const registered = await fetch(`${harness.baseUrl}/v1/anywhere/device`, {
    method: "POST",
    headers: { origin: TEST_EXTENSION_ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ deviceId }),
  });
  expect(registered.status).toBe(200);
  token = ((await registered.json()) as { sessionToken: string }).sessionToken;
});

afterAll(async () => {
  await harness.close();
});

describe("the turn loop", () => {
  it("runs a read action to a verified completion and counts the task", async () => {
    const task = `read the heading ${randomUUID()}`;
    scripts.set(task, [
      modelMessage(
        [
          toolUse("page_action", {
            action: { kind: "readBack", target: { id: "e00000001" } },
            expect: [
              { kind: "element-present", target: { role: "heading", name: "Billing settings" } },
            ],
            summary: "Read the page heading back",
          }),
        ],
        "tool_use",
      ),
      modelMessage(
        [
          { type: "text", text: "The heading is Billing settings." },
          toolUse("finish", { outcome: "completed", detail: "read the heading back" }),
        ],
        "tool_use",
      ),
    ]);
    const before = await usedToday();
    const turnId = await startTask(task);

    const request = await awaitEvent(turnId, "action-request", (event) => !event.needsConfirmation);
    expect(request.risk).toBe("read");
    await deliverResult(turnId, request.actionId);

    const report = await awaitEvent(turnId, "report");
    expect(report.outcome).toBe("completed");
    await awaitEvent(turnId, "quota");
    const end = await awaitEvent(turnId, "turn-end");
    expect(end.status).toBe("completed");
    await awaitTurnStatus(turnId, "completed");
    expect(await usedToday()).toBe(before + 1);

    const kinds = await trajectoryKinds(turnId);
    for (const expected of [
      "task-received",
      "injection-scan",
      "model-response",
      "action-planned",
      "policy-verdict",
      "action-dispatched",
      "action-result",
      "observation",
      "report",
      "turn-end",
    ]) {
      expect(kinds, kinds.join(",")).toContain(expected);
    }
  });

  it("asks before a write, executes after approval, and consumes the confirmation", async () => {
    const task = `update the email ${randomUUID()}`;
    scripts.set(task, [
      modelMessage(
        [
          toolUse("page_action", {
            action: { kind: "type", target: { id: "e00000002" }, value: "new@example.com" },
            expect: [
              {
                kind: "value-equals",
                target: { role: "textbox", name: "Contact email" },
                value: "new@example.com",
              },
            ],
            summary: "Type the new contact email",
          }),
        ],
        "tool_use",
      ),
      modelMessage(
        [toolUse("finish", { outcome: "completed", detail: "email updated" })],
        "tool_use",
      ),
    ]);
    const turnId = await startTask(task);

    const asked = await awaitEvent(turnId, "action-request", (event) => event.needsConfirmation);
    const approved = await api("/v1/anywhere/confirm", {
      turnId,
      actionId: asked.actionId,
      paramsHash: asked.paramsHash,
      approved: true,
    });
    expect(approved.status).toBe(204);

    const dispatch = await awaitEvent(
      turnId,
      "action-request",
      (event) => !event.needsConfirmation,
    );
    expect(dispatch.actionId).toBe(asked.actionId);
    await deliverResult(turnId, dispatch.actionId, {
      ...digest,
      nodes: digest.nodes.map((node) =>
        node.id === "e00000002" ? { ...node, value: "new@example.com" } : node,
      ),
    });

    const report = await awaitEvent(turnId, "report");
    expect(report.outcome).toBe("completed");
    const end = await awaitEvent(turnId, "turn-end");
    expect(end.status).toBe("completed");

    const consumed = await harness.database.pool.query<{ consumed: boolean }>(
      "SELECT consumed FROM confirmation WHERE action_id = $1",
      [asked.actionId],
    );
    expect(consumed.rows[0]?.consumed).toBe(true);
  });

  it("does not ask again for a later write in the same turn", async () => {
    const task = `two writes ${randomUUID()}`;
    scripts.set(task, [
      modelMessage(
        [
          toolUse("page_action", {
            action: { kind: "click", target: { id: "e00000002" } },
            expect: [],
            summary: "Focus the contact email",
          }),
        ],
        "tool_use",
      ),
      modelMessage(
        [
          toolUse("page_action", {
            action: { kind: "type", target: { id: "e00000002" }, value: "two@example.com" },
            expect: [],
            summary: "Type the contact email",
          }),
        ],
        "tool_use",
      ),
      modelMessage(
        [toolUse("finish", { outcome: "completed", detail: "email typed" })],
        "tool_use",
      ),
    ]);
    const turnId = await startTask(task);

    const first = await awaitEvent(turnId, "action-request", (event) => event.needsConfirmation);
    expect(
      (
        await api("/v1/anywhere/confirm", {
          turnId,
          actionId: first.actionId,
          paramsHash: first.paramsHash,
          approved: true,
        })
      ).status,
    ).toBe(204);
    const firstDispatch = await awaitEvent(
      turnId,
      "action-request",
      (event) => !event.needsConfirmation && event.actionId === first.actionId,
    );
    await deliverResult(turnId, firstDispatch.actionId);

    const second = await awaitEvent(
      turnId,
      "action-request",
      (event) => event.actionId !== first.actionId,
    );
    expect(second.needsConfirmation).toBe(false);
    await deliverResult(turnId, second.actionId);

    const end = await awaitEvent(turnId, "turn-end");
    expect(end.status).toBe("completed");
  });

  it("still asks for a sensitive action after write consent", async () => {
    const task = `sensitive after write ${randomUUID()}`;
    scripts.set(task, [
      modelMessage(
        [
          toolUse("page_action", {
            action: { kind: "click", target: { id: "e00000002" } },
            expect: [],
            summary: "Focus the contact email",
          }),
        ],
        "tool_use",
      ),
      modelMessage(
        [
          toolUse("page_action", {
            action: { kind: "click", target: { id: "e00000001" } },
            expect: [],
            summary: "Open billing",
          }),
        ],
        "tool_use",
      ),
      modelMessage(
        [toolUse("finish", { outcome: "completed", detail: "opened billing" })],
        "tool_use",
      ),
    ]);
    const turnId = await startTask(task);

    const writeAsk = await awaitEvent(turnId, "action-request", (event) => event.needsConfirmation);
    expect(
      (
        await api("/v1/anywhere/confirm", {
          turnId,
          actionId: writeAsk.actionId,
          paramsHash: writeAsk.paramsHash,
          approved: true,
        })
      ).status,
    ).toBe(204);
    await deliverResult(
      turnId,
      (
        await awaitEvent(
          turnId,
          "action-request",
          (event) => !event.needsConfirmation && event.actionId === writeAsk.actionId,
        )
      ).actionId,
    );

    const sensitiveAsk = await awaitEvent(
      turnId,
      "action-request",
      (event) => event.needsConfirmation && event.actionId !== writeAsk.actionId,
    );
    expect(sensitiveAsk.risk).toBe("sensitive");
    expect(
      (
        await api("/v1/anywhere/confirm", {
          turnId,
          actionId: sensitiveAsk.actionId,
          paramsHash: sensitiveAsk.paramsHash,
          approved: true,
        })
      ).status,
    ).toBe(204);
    await deliverResult(
      turnId,
      (
        await awaitEvent(
          turnId,
          "action-request",
          (event) => !event.needsConfirmation && event.actionId === sensitiveAsk.actionId,
        )
      ).actionId,
    );

    const end = await awaitEvent(turnId, "turn-end");
    expect(end.status).toBe("completed");
  });

  it("treats a decline as a refusal and does not execute", async () => {
    const task = `declined write ${randomUUID()}`;
    scripts.set(task, [
      modelMessage(
        [
          toolUse("page_action", {
            action: { kind: "type", target: { id: "e00000002" }, value: "evil@example.com" },
            expect: [],
            summary: "Type a new contact email",
          }),
        ],
        "tool_use",
      ),
      modelMessage(
        [toolUse("finish", { outcome: "not-completed", detail: "the person declined" })],
        "tool_use",
      ),
    ]);
    const before = await usedToday();
    const turnId = await startTask(task);

    const asked = await awaitEvent(turnId, "action-request", (event) => event.needsConfirmation);
    const declined = await api("/v1/anywhere/confirm", {
      turnId,
      actionId: asked.actionId,
      paramsHash: asked.paramsHash,
      approved: false,
    });
    expect(declined.status).toBe(204);

    const refusal = await awaitEvent(turnId, "refusal");
    expect(refusal.reason).toBe("declined_by_user");
    const end = await awaitEvent(turnId, "turn-end");
    expect(end.status).toBe("failed");
    await awaitTurnStatus(turnId, "failed");
    expect(await usedToday()).toBe(before);

    const all = await events(turnId);
    const dispatches = all.filter(
      (event) => event.kind === "action-request" && !event.needsConfirmation,
    );
    expect(dispatches).toEqual([]);
  });

  it("refuses every state-changing action under an observe grant, unconfirmably", async () => {
    const task = `observe write ${randomUUID()}`;
    scripts.set(task, [
      modelMessage(
        [
          toolUse("page_action", {
            action: { kind: "click", target: { id: "e00000002" } },
            expect: [],
            summary: "Click the email field",
          }),
        ],
        "tool_use",
      ),
      modelMessage(
        [toolUse("finish", { outcome: "not-completed", detail: "observe grant blocks this" })],
        "tool_use",
      ),
    ]);
    const turnId = await startTask(task, "observe");

    const refusal = await awaitEvent(turnId, "refusal");
    expect(refusal.reason).toBe("grant_insufficient");
    const end = await awaitEvent(turnId, "turn-end");
    expect(end.status).toBe("failed");

    const all = await events(turnId);
    expect(all.filter((event) => event.kind === "action-request")).toEqual([]);
  });

  it("reports a model refusal instead of retrying", async () => {
    const task = `model refusal ${randomUUID()}`;
    scripts.set(task, [
      modelMessage([], "refusal"),
    ]);
    const turnId = await startTask(task);

    const refusal = await awaitEvent(turnId, "refusal");
    expect(refusal.reason).toBe("model_refusal");
    expect(refusal.detail).toContain("declined");
    const end = await awaitEvent(turnId, "turn-end");
    expect(end.status).toBe("failed");
  });

  it("continues through pause_turn", async () => {
    const task = `paused turn ${randomUUID()}`;
    scripts.set(task, [
      modelMessage([{ type: "text", text: "thinking this over" }], "pause_turn"),
      modelMessage(
        [toolUse("finish", { outcome: "not-completed", detail: "nothing to do here" })],
        "tool_use",
      ),
    ]);
    const turnId = await startTask(task);
    const report = await awaitEvent(turnId, "report");
    expect(report.detail).toBe("nothing to do here");
  });

  it("ends needing input when the model just talks", async () => {
    const task = `talks only ${randomUUID()}`;
    scripts.set(task, [
      modelMessage(
        [{ type: "text", text: "Which email should I use?" }],
        "end_turn",
      ),
    ]);
    const before = await usedToday();
    const turnId = await startTask(task);
    const end = await awaitEvent(turnId, "turn-end");
    expect(end.status).toBe("needs-input");
    await awaitTurnStatus(turnId, "needs-input");
    expect(await usedToday()).toBe(before);
  });

  it("asks one precise question through ask_user", async () => {
    const task = `asks a question ${randomUUID()}`;
    scripts.set(task, [
      modelMessage([toolUse("ask_user", { question: "Which plan should I pick?" })], "tool_use"),
    ]);
    const turnId = await startTask(task);
    const question = await awaitEvent(turnId, "question");
    expect(question.text).toBe("Which plan should I pick?");
    const end = await awaitEvent(turnId, "turn-end");
    expect(end.status).toBe("needs-input");
  });

  it("exhausts the step budget with an honest report, not a claim", async () => {
    const task = `budget spender ${randomUUID()}`;
    const readAction = (): BetaMessage =>
      modelMessage(
        [
          toolUse("page_action", {
            action: { kind: "readBack", target: { id: "e00000001" } },
            expect: [],
            summary: "Read the heading again",
          }),
        ],
        "tool_use",
      );
    scripts.set(task, [readAction(), readAction(), readAction()]);
    const before = await usedToday();
    const turnId = await startTask(task);

    for (let round = 0; round < 3; round += 1) {
      const all = await events(turnId);
      const seen = new Set(
        all.filter((event) => event.kind === "action-request").map((event) => event.actionId),
      );
      const next = await awaitEvent(
        turnId,
        "action-request",
        (event) => !event.needsConfirmation && !seen.has(event.actionId),
      );
      await deliverResult(turnId, next.actionId);
    }

    const report = await awaitEvent(turnId, "report");
    expect(report.outcome).toBe("not-completed");
    expect(report.detail).toContain("step budget");
    const end = await awaitEvent(turnId, "turn-end");
    expect(end.status).toBe("failed");
    expect(await usedToday()).toBe(before);
  });

  it("downgrades a completion claim that contradicts a failed predicate", async () => {
    const task = `false claim ${randomUUID()}`;
    scripts.set(task, [
      modelMessage(
        [
          toolUse("page_action", {
            action: { kind: "readBack", target: { id: "e00000001" } },
            expect: [{ kind: "element-present", target: { role: "alert", name: "Saved" } }],
            summary: "Look for a saved banner",
          }),
        ],
        "tool_use",
      ),
      modelMessage([toolUse("finish", { outcome: "completed", detail: "all done" })], "tool_use"),
    ]);
    const before = await usedToday();
    const turnId = await startTask(task);

    const request = await awaitEvent(turnId, "action-request", (event) => !event.needsConfirmation);
    await deliverResult(turnId, request.actionId);

    const report = await awaitEvent(turnId, "report");
    expect(report.outcome).toBe("not-completed");
    expect(report.failedPredicate).toEqual({
      kind: "element-present",
      target: { role: "alert", name: "Saved" },
    });
    const end = await awaitEvent(turnId, "turn-end");
    expect(end.status).toBe("failed");
    expect(await usedToday()).toBe(before);
  });
});
