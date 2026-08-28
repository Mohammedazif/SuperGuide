import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  TEST_EXTENSION_ORIGIN,
  TEST_ORIGIN,
  createTestProduct,
  startHarness,
  type TestHarness,
} from "../helpers/server.js";

describe("anywhere and widget origins do not mix", () => {
  let harness: TestHarness;
  let productId: string;

  beforeAll(async () => {
    harness = await startHarness();
    ({ productId } = await createTestProduct());
  });

  afterAll(async () => {
    await harness.close();
  });

  it("a widget origin cannot open the extension door", async () => {
    const response = await fetch(`${harness.baseUrl}/v1/anywhere/device`, {
      method: "POST",
      headers: {
        origin: TEST_ORIGIN,
        "content-type": "application/json",
        "x-sg-product-id": productId,
      },
      body: JSON.stringify({ deviceId: randomUUID() }),
    });
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("origin_rejected");
  });

  it("an extension origin cannot open a widget session", async () => {
    const response = await fetch(`${harness.baseUrl}/v1/session`, {
      method: "POST",
      headers: {
        origin: TEST_EXTENSION_ORIGIN,
        "content-type": "application/json",
        "x-sg-product-id": productId,
        "x-sga-extension-origin": TEST_EXTENSION_ORIGIN,
      },
      body: JSON.stringify({ productId }),
    });
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("origin_not_allowed");
  });

  it("widget chat still works with the product origin", async () => {
    const session = await fetch(`${harness.baseUrl}/v1/session`, {
      method: "POST",
      headers: {
        origin: TEST_ORIGIN,
        "content-type": "application/json",
        "x-sg-product-id": productId,
      },
      body: JSON.stringify({ productId }),
    });
    expect(session.status).toBe(200);
  });
});
