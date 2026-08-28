import { describe, expect, it } from "vitest";
import { Transport } from "./transport.js";

const PRODUCT = "11111111-1111-4111-8111-111111111111";
const SESSION_TOKEN = "a-session-token-this-test-invented";

function transport(): Transport {
  return new Transport({ apiUrl: "https://api.trysuperguide.com", productId: PRODUCT });
}

describe("the transport", () => {
  // CORS preflight has no custom headers, so productId cannot live only in x-sg-product-id.
  it("carries the product in the url as well as the header", () => {
    for (const path of ["/v1/session", "/v1/chat", "/v1/stream", "/v1/tool-result", "/v1/confirm"]) {
      const url = new URL(transport().url(path));
      expect({ path, productId: url.searchParams.get("productId") }).toEqual({
        path,
        productId: PRODUCT,
      });
    }
  });

  it("builds a url that another query parameter can be added to", () => {
    const url = new URL(transport().url("/v1/stream"));
    url.searchParams.set("conversationId", "22222222-2222-4222-8222-222222222222");

    expect(url.toString().match(/\?/g)).toHaveLength(1);
    expect(url.searchParams.get("productId")).toBe(PRODUCT);
    expect(url.searchParams.get("conversationId")).toBe("22222222-2222-4222-8222-222222222222");
  });

  it("sends the product header and adds the bearer only once a session exists", () => {
    const subject = transport();
    expect(subject.headers()["authorization"]).toBeUndefined();
    expect(subject.headers()["x-sg-product-id"]).toBe(PRODUCT);

    subject.setSessionToken(SESSION_TOKEN);
    expect(subject.headers()["authorization"]).toBe(`Bearer ${SESSION_TOKEN}`);

    subject.setSessionToken(null);
    expect(subject.headers()["authorization"]).toBeUndefined();
  });

  it("reports an unreachable control plane rather than throwing into the host page", async () => {
    const offline = new Transport({
      apiUrl: "https://api.trysuperguide.com",
      productId: PRODUCT,
      fetchImplementation: () => Promise.reject(new Error("offline")),
    });

    const result = await offline.openSession();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("network_unreachable");
  });

  it("surfaces a contract error code the widget can act on", async () => {
    const limited = new Transport({
      apiUrl: "https://api.trysuperguide.com",
      productId: PRODUCT,
      fetchImplementation: () =>
        Promise.resolve(
          new Response(JSON.stringify({ error: { code: "rate_limited", message: "slow down" } }), {
            status: 429,
          }),
        ),
    });

    const result = await limited.openSession();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("rate_limited");
    expect(result.status).toBe(429);
  });
});
