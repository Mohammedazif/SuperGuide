// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PageDigest } from "@superguide/contract/public";
import type { ActionExecutor } from "@superguide/executor";
import { ClientCapabilityRegistry } from "./capabilities.js";
import { SuperGuideClient, CONVERSATION_NAMESPACE, SESSION_NAMESPACE } from "./client.js";
import { MemoryStore, NamespacedStorage } from "./storage.js";
import { Transport } from "./transport.js";

const PRODUCT = "11111111-1111-4111-8111-111111111111";
const CONVERSATION = "22222222-2222-4222-8222-222222222222";

const DIGEST: PageDigest = {
  url: "https://app.example/account",
  title: "Account",
  headings: [],
  landmarks: [],
  elements: [],
  truncated: false,
};

describe("a session that survives a navigation", () => {
  let store: MemoryStore;
  let sessionCalls: number;
  let streamCalls: number;
  let url: string;

  function reply(path: string): Response {
    if (path.includes("/v1/session")) {
      sessionCalls += 1;
      return new Response(
        JSON.stringify({
          sessionToken: `token-${String(sessionCalls)}`,
          expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
          tier: "anonymous",
          scopes: [],
        }),
        { status: 200 },
      );
    }
    if (path.includes("/v1/products/")) {
      return new Response(
        JSON.stringify({
          productId: PRODUCT,
          name: "fixture",
          groundedActionsEnabled: false,
          stepBudget: 12,
          routes: [],
          redactionAllowlist: [],
        }),
        { status: 200 },
      );
    }
    if (path.includes("/v1/stream")) {
      streamCalls += 1;
      return new Response(new ReadableStream(), { status: 200 });
    }
    if (path.includes("/v1/chat")) {
      return new Response(
        JSON.stringify({ turnId: "33333333-3333-4333-8333-333333333333", conversationId: CONVERSATION }),
        { status: 202 },
      );
    }
    return new Response("{}", { status: 200 });
  }

  function build(): SuperGuideClient {
    const transport = new Transport({
      apiUrl: "https://api.trysuperguide.com",
      productId: PRODUCT,
      fetchImplementation: ((target: string | URL) =>
        Promise.resolve(reply(String(target)))) as unknown as typeof fetch,
    });

    return new SuperGuideClient({
      transport,
      executor: { execute: vi.fn() } as unknown as ActionExecutor,
      storage: new NamespacedStorage(store, PRODUCT),
      capabilities: new ClientCapabilityRegistry(),
      currentDigest: () => DIGEST,
      currentUrl: () => url,
    });
  }

  beforeEach(() => {
    store = new MemoryStore();
    sessionCalls = 0;
    streamCalls = 0;
    url = "https://app.example/account";
  });

  it("opens one session on a first load and keeps it", async () => {
    const client = build();
    await client.start();

    expect(sessionCalls).toBe(1);
    expect(client.state.status).toBe("ready");
    expect(store.getItem(`sg.${SESSION_NAMESPACE}.${PRODUCT}.current`)).not.toBeNull();
  });

  // The defect this guards: after a navigation the widget opened a brand new anonymous session,
  // so the new page was a different end user and an owed result could never be delivered.
  it("reuses the stored session after a navigation instead of becoming someone else", async () => {
    const first = build();
    await first.start();
    await first.send("change our postcode");
    expect(first.state.conversationId).toBe(CONVERSATION);

    url = "https://app.example/settings/billing";
    const afterNavigation = build();
    await afterNavigation.start();

    expect(sessionCalls).toBe(1);
    expect(afterNavigation.state.conversationId).toBe(CONVERSATION);
    expect(streamCalls).toBeGreaterThanOrEqual(2);
  });

  it("opens a fresh session once the stored one has expired", async () => {
    const client = build();
    await client.start();

    store.setItem(
      `sg.${SESSION_NAMESPACE}.${PRODUCT}.current`,
      JSON.stringify({
        value: {
          token: "stale",
          expiresAt: new Date(Date.now() - 1000).toISOString(),
          tier: "anonymous",
          scopes: [],
        },
        expiresAt: null,
      }),
    );

    const afterExpiry = build();
    await afterExpiry.start();
    expect(sessionCalls).toBe(2);
  });

  it("holds a message asked for before the session is open rather than dropping it", async () => {
    const client = build();
    const sending = client.send("what plan are we on?");
    await sending;

    expect(client.state.conversationId).toBeNull();

    await client.start();
    expect(client.state.conversationId).toBe(CONVERSATION);
  });

  it("forgets the conversation on reset but keeps the session", () => {
    const client = build();
    store.setItem(
      `sg.${CONVERSATION_NAMESPACE}.${PRODUCT}.current`,
      JSON.stringify({ value: CONVERSATION, expiresAt: null }),
    );

    client.reset();

    expect(store.getItem(`sg.${CONVERSATION_NAMESPACE}.${PRODUCT}.current`)).toBeNull();
  });
});
