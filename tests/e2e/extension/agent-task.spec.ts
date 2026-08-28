import pg from "pg";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import {
  EXTENSION_ID,
  launchWithExtension,
  serviceWorkerOf,
  stageExtension,
} from "./helpers/launch.js";
import {
  spawnControlPlane,
  appDatabaseUrl,
  type ControlPlaneProcess,
} from "./helpers/control-plane-process.js";
import { spawnFixtureApp, type FixtureAppProcess } from "./helpers/fixture-app-process.js";
import { liveProvider } from "../../helpers/live.js";

const live = liveProvider();

test.describe.configure({ mode: "serial" });
test.skip(live.key === null || live.key.length === 0, `${live.keyName} is not set; the live agent task cannot run`);

let server: ControlPlaneProcess;
let app: FixtureAppProcess;
let context: BrowserContext;
let page: Page;
let pool: pg.Pool;

test.beforeAll(async () => {
  pool = new pg.Pool({ connectionString: appDatabaseUrl() });
  server = await spawnControlPlane({ agentLoop: "on" });
  app = await spawnFixtureApp();
  const staged = stageExtension(["http://127.0.0.1/*"]);
  context = await launchWithExtension(staged);
  const worker = await serviceWorkerOf(context);
  await worker.evaluate(
    (base) => chrome.storage.local.set({ "sga.apiBase": base }),
    server.baseUrl,
  );
  page = await context.newPage();
  await page.goto(`${app.origin}/settings/billing`);
  const popup = await context.newPage();
  await popup.goto(
    `chrome-extension://${EXTENSION_ID}/popup.html?target=${encodeURIComponent(app.origin)}`,
  );
  await popup.getByTestId("activate").click();
  await expect(popup.getByTestId("tier")).toHaveText("Can observe and act");
  await popup.close();
  await expect(page.locator("#sga-root")).toHaveCount(1);
});

test.afterAll(async () => {
  await context.close();
  await app.stop();
  await server.stop();
  await pool.end();
});

test("the agent completes a real task end to end against the fixture app", async () => {
  test.setTimeout(300_000);
  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  const { width, height } = viewport as { width: number; height: number };

  await page.mouse.click(width - 32, height - 32);
  await page.mouse.click(width - 220, height - 100);
  await page.keyboard.type("Read back this page's main heading and tell me what it says.");
  await page.keyboard.press("Enter");

  const turnId = await (async () => {
    const deadline = Date.now() + 30_000;
    for (;;) {
      const rows = await pool.query<{ id: string }>(
        "SELECT id FROM turn ORDER BY created_at DESC LIMIT 1",
      );
      const found = rows.rows[0]?.id;
      if (found !== undefined) return found;
      if (Date.now() > deadline) throw new Error("no turn was created");
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
    }
  })();

  const status = await (async () => {
    const deadline = Date.now() + 240_000;
    for (;;) {
      const rows = await pool.query<{ status: string }>("SELECT status FROM turn WHERE id = $1", [
        turnId,
      ]);
      const current = rows.rows[0]?.status ?? "missing";
      if (current !== "running") return current;
      if (Date.now() > deadline) throw new Error("the turn did not settle");
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 1000));
    }
  })();
  expect(status).toBe("completed");

  const kinds = await pool.query<{ kind: string }>(
    "SELECT kind FROM trajectory WHERE turn_id = $1 ORDER BY seq",
    [turnId],
  );
  const seen = kinds.rows.map((row) => row.kind);
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
    expect(seen, seen.join(",")).toContain(expected);
  }

  const requested = await pool.query<{ payload: { kind: string; action?: { kind: string } } }>(
    "SELECT payload FROM turn_event WHERE turn_id = $1 ORDER BY seq",
    [turnId],
  );
  const actionEvents = requested.rows
    .map((row) => row.payload)
    .filter((event) => event.kind === "action-request");
  expect(actionEvents.length).toBeGreaterThan(0);
  for (const event of actionEvents) {
    expect(["readBack", "waitFor"]).toContain(event.action?.kind ?? "missing");
  }
  const report = requested.rows
    .map((row) => row.payload as { kind: string; outcome?: string })
    .find((event) => event.kind === "report");
  expect(report?.outcome).toBe("completed");
});
