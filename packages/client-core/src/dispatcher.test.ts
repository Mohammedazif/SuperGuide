// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutorAction, ToolResultPayload } from "@superguide/contract/public";
import type { ActionExecutor } from "@superguide/executor";
import { DELIVERED_TTL_MS, PENDING_NAMESPACE, ToolDispatcher } from "./dispatcher.js";
import { MemoryStore, NamespacedStorage } from "./storage.js";
import { Transport } from "./transport.js";

const PRODUCT = "11111111-1111-4111-8111-111111111111";
const CONVERSATION = "22222222-2222-4222-8222-222222222222";

function action(overrides: Partial<ExecutorAction> = {}): ExecutorAction {
  return {
    type: "navigate_route",
    toolCallId: "toolu_nav",
    intent: "Take you to billing.",
    expect: [{ kind: "url_matches", pattern: "/settings/billing" }],
    risk: "read",
    timeoutMs: 20_000,
    routeId: "billing_settings",
    params: {},
    ...overrides,
  } as ExecutorAction;
}

describe("durable tool dispatch", () => {
  let store: MemoryStore;
  let storage: NamespacedStorage;
  let delivered: { toolCallId: string; payload: ToolResultPayload }[];
  let responses: Response[];
  let requests: { url: string; body: unknown; keepalive: boolean }[];
  let clock: number;

  function transportFor(): Transport {
    const transport = new Transport({
      apiUrl: "https://api.trysuperguide.com",
      productId: PRODUCT,
      fetchImplementation: ((url: string, init: RequestInit) => {
        requests.push({
          url,
          body: typeof init.body === "string" ? (JSON.parse(init.body) as unknown) : null,
          keepalive: init.keepalive === true,
        });
        const next = responses.shift() ?? new Response(JSON.stringify({ status: "accepted" }), { status: 202 });
        return Promise.resolve(next);
      }) as unknown as typeof fetch,
    });
    transport.setSessionToken("session-token");
    return transport;
  }

  beforeEach(() => {
    store = new MemoryStore();
    clock = 1_000_000;
    storage = new NamespacedStorage(store, PRODUCT, () => clock);
    delivered = [];
    responses = [];
    requests = [];
  });

  function dispatcherWith(executor: Partial<ActionExecutor>, url = "https://app.example/account"): ToolDispatcher {
    return new ToolDispatcher({
      transport: transportFor(),
      storage,
      executor: executor as ActionExecutor,
      currentUrl: () => url,
      now: () => clock,
      onDelivered: (toolCallId, payload) => delivered.push({ toolCallId, payload }),
    });
  }

  it("records a pending call before the action runs, not after", async () => {
    let pendingDuringExecution: string[] = [];

    const dispatcher = dispatcherWith({
      execute: () => {
        pendingDuringExecution = storage
          .entries<{ toolCallId: string }>(PENDING_NAMESPACE)
          .map((entry) => entry.id);
        return Promise.resolve({
          status: "ok",
          data: null,
          digest: null,
          url: "https://app.example/settings/billing",
        });
      },
    });

    await dispatcher.dispatch(CONVERSATION, action());
    expect(pendingDuringExecution).toEqual(["toolu_nav"]);
    expect(dispatcher.inFlight()).toEqual([]);
    expect(delivered).toHaveLength(1);
  });

  it("keeps the pending record when delivery fails so boot can retry", async () => {
    responses = [new Response("{}", { status: 500 })];
    const dispatcher = dispatcherWith({
      execute: () =>
        Promise.resolve({ status: "ok", data: null, digest: null, url: "https://app.example/x" }),
    });

    await dispatcher.dispatch(CONVERSATION, action());
    expect(dispatcher.inFlight().map((record) => record.toolCallId)).toEqual(["toolu_nav"]);
    expect(delivered).toEqual([]);
  });

  it("reports every in-flight call as interrupted when the page goes away", () => {
    const dispatcher = dispatcherWith({
      execute: () => new Promise(() => undefined),
    });
    void dispatcher.dispatch(CONVERSATION, action({ type: "click", ref: "e1", toolCallId: "toolu_click" }));

    dispatcher.reportInterruptedByNavigation();

    const sent = requests.filter((request) => request.url.includes("/v1/tool-result"));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.keepalive).toBe(true);
    const body = sent[0]?.body as { result: { error: { code: string } } };
    expect(body.result.error.code).toBe("NAV_INTERRUPTED");
  });

  it("reports a navigation that actually happened as the success it was", async () => {
    const dispatcher = dispatcherWith({ execute: () => new Promise(() => undefined) });
    void dispatcher.dispatch(CONVERSATION, action());
    expect(dispatcher.inFlight()).toHaveLength(1);

    const afterBoot = new ToolDispatcher({
      transport: transportFor(),
      storage,
      executor: {} as ActionExecutor,
      currentUrl: () => "https://app.example/settings/billing",
      now: () => clock,
      onDelivered: (toolCallId, payload) => delivered.push({ toolCallId, payload }),
    });

    const replayed = await afterBoot.replayPending({
      url: "https://app.example/settings/billing",
      title: "Billing",
      headings: [],
      landmarks: [],
      elements: [],
      truncated: false,
    });

    expect(replayed).toBe(1);
    expect(delivered[0]?.payload.status).toBe("ok");
    expect(afterBoot.inFlight()).toEqual([]);
  });

  it("reports an interrupted non-navigation call as interrupted on boot", async () => {
    const dispatcher = dispatcherWith({ execute: () => new Promise(() => undefined) });
    void dispatcher.dispatch(CONVERSATION, action({ type: "click", ref: "e1", toolCallId: "toolu_click" }));

    const afterBoot = new ToolDispatcher({
      transport: transportFor(),
      storage,
      executor: {} as ActionExecutor,
      currentUrl: () => "https://app.example/somewhere-else",
      now: () => clock,
      onDelivered: (toolCallId, payload) => delivered.push({ toolCallId, payload }),
    });

    await afterBoot.replayPending(null);
    expect(delivered[0]?.payload.status).toBe("failed");
    if (delivered[0]?.payload.status === "failed") {
      expect(delivered[0].payload.error.code).toBe("NAV_INTERRUPTED");
    }
  });

  it("never delivers the same call twice within the retention window", async () => {
    const execute = vi.fn(() =>
      Promise.resolve({ status: "ok" as const, data: null, digest: null, url: "https://app.example/x" }),
    );
    const dispatcher = dispatcherWith({ execute });

    await dispatcher.dispatch(CONVERSATION, action());
    await dispatcher.dispatch(CONVERSATION, action());

    expect(execute).toHaveBeenCalledTimes(1);
    expect(requests.filter((request) => request.url.includes("/v1/tool-result"))).toHaveLength(1);
  });

  it("forgets a delivered call once its retention window passes", async () => {
    const execute = vi.fn(() =>
      Promise.resolve({ status: "ok" as const, data: null, digest: null, url: "https://app.example/x" }),
    );
    const dispatcher = dispatcherWith({ execute });

    await dispatcher.dispatch(CONVERSATION, action());
    clock += DELIVERED_TTL_MS + 1;
    await dispatcher.dispatch(CONVERSATION, action());

    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("namespaces every key under the storage prefix and the product", () => {
    storage.write("pending", "abc", { any: true });
    expect(store.keys()).toEqual([`sg.pending.${PRODUCT}.abc`]);
  });
});
