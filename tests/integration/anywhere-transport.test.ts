import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  TEST_EXTENSION_ORIGIN,
  startHarness,
  type TestHarness,
} from "../helpers/server.js";

const EMPTY_DIGEST = {
  url: "https://app.example/settings",
  title: "Settings",
  nodes: [],
};

describe("anywhere transport", () => {
  let harness: TestHarness;

  beforeAll(async () => {
    harness = await startHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  function headers(token?: string, origin = TEST_EXTENSION_ORIGIN): Record<string, string> {
    return {
      origin,
      "content-type": "application/json",
      "x-sga-extension-origin": origin,
      ...(token === undefined ? {} : { "x-sga-device-token": token }),
    };
  }

  async function registerDevice(deviceId = randomUUID()): Promise<{ deviceId: string; token: string }> {
    const response = await fetch(`${harness.baseUrl}/v1/anywhere/device`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ deviceId }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { sessionToken: string; expiresAt: string };
    expect(body.sessionToken.length).toBeGreaterThan(8);
    return { deviceId, token: body.sessionToken };
  }

  it("rejects a missing origin", async () => {
    const response = await fetch(`${harness.baseUrl}/v1/anywhere/device`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceId: randomUUID() }),
    });
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("origin_rejected");
  });

  it("rejects a product origin on the extension door", async () => {
    const response = await fetch(`${harness.baseUrl}/v1/anywhere/device`, {
      method: "POST",
      headers: headers(undefined, "https://app.example"),
      body: JSON.stringify({ deviceId: randomUUID() }),
    });
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("origin_rejected");
  });

  it("registers a device and returns quota", async () => {
    const { token } = await registerDevice();
    const response = await fetch(`${harness.baseUrl}/v1/anywhere/quota`, {
      headers: headers(token),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { quota: { used: number; limit: number } };
    expect(body.quota.used).toBe(0);
    expect(body.quota.limit).toBe(20);
  });

  it("refuses quota without a token", async () => {
    const response = await fetch(`${harness.baseUrl}/v1/anywhere/quota`, {
      headers: headers(),
    });
    expect(response.status).toBe(401);
  });

  it("accepts a task with 202", async () => {
    const { token } = await registerDevice();
    const response = await fetch(`${harness.baseUrl}/v1/anywhere/task`, {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify({
        origin: "https://app.example",
        url: "https://app.example/settings",
        tier: "observe",
        taskText: "what city is on the invoice",
        digest: EMPTY_DIGEST,
        adapterSetVersion: 1,
      }),
    });
    expect(response.status).toBe(202);
    const body = (await response.json()) as { turnId: string; quota: { used: number } };
    expect(body.turnId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.quota.used).toBe(0);
  });

  it("streams only to the device that owns the turn", async () => {
    const owner = await registerDevice();
    const other = await registerDevice();
    const started = await fetch(`${harness.baseUrl}/v1/anywhere/task`, {
      method: "POST",
      headers: headers(owner.token),
      body: JSON.stringify({
        origin: "https://app.example",
        url: "https://app.example/settings",
        tier: "observe",
        taskText: "read the plan",
        digest: EMPTY_DIGEST,
        adapterSetVersion: null,
      }),
    });
    const { turnId } = (await started.json()) as { turnId: string };

    const forbidden = await fetch(`${harness.baseUrl}/v1/anywhere/stream?turnId=${turnId}`, {
      headers: headers(other.token),
    });
    expect(forbidden.status).toBe(404);

    const allowed = await fetch(`${harness.baseUrl}/v1/anywhere/stream?turnId=${turnId}`, {
      headers: headers(owner.token),
    });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("content-type")).toMatch(/text\/event-stream/);
    await allowed.body?.cancel();
  });

  it("lists adapters for a registered device", async () => {
    const { token } = await registerDevice();
    const response = await fetch(`${harness.baseUrl}/v1/anywhere/adapters`, {
      headers: headers(token),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { version: number; adapters: unknown[] };
    expect(body.version).toBe(1);
    expect(body.adapters).toEqual([]);
  });

  it("erases the device row without revoking the session token", async () => {
    const { token } = await registerDevice();
    const erased = await fetch(`${harness.baseUrl}/v1/anywhere/erase`, {
      method: "POST",
      headers: {
        origin: TEST_EXTENSION_ORIGIN,
        "x-sga-extension-origin": TEST_EXTENSION_ORIGIN,
        "x-sga-device-token": token,
      },
    });
    expect(erased.status).toBe(204);

    const quota = await fetch(`${harness.baseUrl}/v1/anywhere/quota`, {
      headers: headers(token),
    });
    expect(quota.status).toBe(200);
    const body = (await quota.json()) as { quota: { used: number; limit: number } };
    expect(body.quota.used).toBe(0);
    expect(body.quota.limit).toBe(20);
  });
});
