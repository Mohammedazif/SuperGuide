import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  startHarness,
  TEST_EXTENSION_ORIGIN,
  type TestHarness,
} from "../helpers/server.js";

let harness: TestHarness;

async function register(): Promise<{ token: string; deviceId: string }> {
  const deviceId = randomUUID();
  const response = await fetch(`${harness.baseUrl}/v1/anywhere/device`, {
    method: "POST",
    headers: { origin: TEST_EXTENSION_ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ deviceId }),
  });
  expect(response.status).toBe(200);
  return { token: ((await response.json()) as { sessionToken: string }).sessionToken, deviceId };
}

function taskBody(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    origin: "https://app.example.com",
    url: "https://app.example.com/settings",
    tier: "control",
    taskText: "any task",
    digest: { url: "https://app.example.com/settings", title: "Settings", nodes: [] },
    adapterSetVersion: null,
    ...extra,
  });
}

beforeAll(async () => {
  harness = await startHarness({ env: { SG_DAILY_TASK_QUOTA: "2" } });
});

afterAll(async () => {
  await harness.close();
});

describe("15.4 quota is server-side", () => {
  it("a client-supplied usage claim is rejected outright: the wire format has no such field", async () => {
    const { token } = await register();
    const response = await fetch(`${harness.baseUrl}/v1/anywhere/task`, {
      method: "POST",
      headers: {
        origin: TEST_EXTENSION_ORIGIN,
        "content-type": "application/json",
        "x-sga-device-token": token,
      },
      body: taskBody({ usage: { used: 0 } }),
    });
    expect(response.status).toBe(400);
  });

  it("past the limit the server answers 429 with the typed body, whatever the client says", async () => {
    const { token, deviceId } = await register();
    await harness.database.pool.query(
      "INSERT INTO device_usage (device_id, day, used) VALUES ($1, (now() at time zone 'utc')::date, 2)",
      [deviceId],
    );
    const response = await fetch(`${harness.baseUrl}/v1/anywhere/task`, {
      method: "POST",
      headers: {
        origin: TEST_EXTENSION_ORIGIN,
        "content-type": "application/json",
        "x-sga-device-token": token,
      },
      body: taskBody(),
    });
    expect(response.status).toBe(429);
    const body = (await response.json()) as { error: { code: string; resetsAt?: string } };
    expect(body.error.code).toBe("quota_exhausted");
    expect(typeof body.error.resetsAt).toBe("string");
  });
});

describe("15.4 quota without release", () => {
  it("lowering SG_DAILY_TASK_QUOTA takes effect with no extension change", async () => {
    const { token } = await register();
    const before = await fetch(`${harness.baseUrl}/v1/anywhere/quota`, {
      headers: { origin: TEST_EXTENSION_ORIGIN, "x-sga-device-token": token },
    });
    expect(((await before.json()) as { quota: { limit: number } }).quota.limit).toBe(2);

    const lowered = await startHarness({ env: { SG_DAILY_TASK_QUOTA: "1" } });
    try {
      const registered = await fetch(`${lowered.baseUrl}/v1/anywhere/device`, {
        method: "POST",
        headers: { origin: TEST_EXTENSION_ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ deviceId: randomUUID() }),
      });
      const loweredToken = ((await registered.json()) as { sessionToken: string }).sessionToken;
      const after = await fetch(`${lowered.baseUrl}/v1/anywhere/quota`, {
        headers: { origin: TEST_EXTENSION_ORIGIN, "x-sga-device-token": loweredToken },
      });
      expect(((await after.json()) as { quota: { limit: number } }).quota.limit).toBe(1);
    } finally {
      await lowered.close();
    }
  });
});

describe("15.4 origin rejection", () => {
  it("rejects a request from an origin outside the allowlist, including on SSE", async () => {
    const { token } = await register();
    for (const origin of ["https://evil.example", undefined]) {
      const task = await fetch(`${harness.baseUrl}/v1/anywhere/task`, {
        method: "POST",
        headers: {
          ...(origin === undefined ? {} : { origin }),
          "content-type": "application/json",
          "x-sga-device-token": token,
        },
        body: taskBody(),
      });
      expect(task.status).toBe(403);
      const stream = await fetch(
        `${harness.baseUrl}/v1/anywhere/stream?turnId=${randomUUID()}&after=-1`,
        {
          headers: {
            ...(origin === undefined ? {} : { origin }),
            "x-sga-device-token": token,
          },
        },
      );
      expect(stream.status).toBe(403);
    }
  });
});

describe("15.4 action idempotency", () => {
  it("delivering the same actionId twice has no second effect", async () => {
    const { token } = await register();
    const started = await fetch(`${harness.baseUrl}/v1/anywhere/task`, {
      method: "POST",
      headers: {
        origin: TEST_EXTENSION_ORIGIN,
        "content-type": "application/json",
        "x-sga-device-token": token,
      },
      body: taskBody(),
    });
    expect(started.status).toBe(202);
    const turnId = ((await started.json()) as { turnId: string }).turnId;
    const actionId = randomUUID();
    const deliver = async (): Promise<number> => {
      const response = await fetch(`${harness.baseUrl}/v1/anywhere/action-result`, {
        method: "POST",
        headers: {
          origin: TEST_EXTENSION_ORIGIN,
          "content-type": "application/json",
          "x-sga-device-token": token,
        },
        body: JSON.stringify({
          turnId,
          actionId,
          result: {
            status: "completed",
            delta: { added: [], removed: [], changed: [], urlChanged: null, titleChanged: null },
          },
          digest: null,
        }),
      });
      return response.status;
    };
    expect(await deliver()).toBe(204);
    expect(await deliver()).toBe(204);
    const rows = await harness.database.pool.query(
      "SELECT 1 FROM action_result WHERE action_id = $1",
      [actionId],
    );
    expect(rows.rowCount).toBe(1);
    const steps = await harness.database.pool.query(
      "SELECT 1 FROM trajectory WHERE turn_id = $1 AND kind = 'action-result'",
      [turnId],
    );
    expect(steps.rowCount).toBe(1);
  });
});
