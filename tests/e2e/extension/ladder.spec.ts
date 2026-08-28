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
test.skip(live.key === null || live.key.length === 0, `${live.keyName} is not set; the live ladder cannot run`);

let server: ControlPlaneProcess;
let app: FixtureAppProcess;
let context: BrowserContext;
let page: Page;
let pool: pg.Pool;

async function newestTurnAfter(cutoff: Date): Promise<string> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const rows = await pool.query<{ id: string }>(
      "SELECT id FROM turn WHERE created_at > $1 ORDER BY created_at DESC LIMIT 1",
      [cutoff],
    );
    const found = rows.rows[0]?.id;
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error("no turn was created");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
}

async function settledStatus(turnId: string): Promise<string> {
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
}

function approveAll(turnId: string): { stop: () => void; askedOnce: () => boolean } {
  const state = { running: true, asked: false };
  const clicked = new Set<string>();
  void (async () => {
    while (state.running) {
      const rows = await pool
        .query<{
          payload: { kind: string; needsConfirmation?: boolean; actionId?: string };
        }>("SELECT payload FROM turn_event WHERE turn_id = $1 ORDER BY seq", [turnId])
        .catch(() => ({
          rows: [] as {
            payload: { kind: string; needsConfirmation?: boolean; actionId?: string };
          }[],
        }));
      for (const row of rows.rows) {
        const event = row.payload;
        if (event.kind !== "action-request" || event.needsConfirmation !== true) continue;
        const actionId = event.actionId ?? "";
        if (clicked.has(actionId)) continue;
        const answered = await pool.query("SELECT 1 FROM confirmation WHERE action_id = $1", [
          actionId,
        ]);
        if (answered.rowCount === 1) {
          clicked.add(actionId);
          continue;
        }
        state.asked = true;
        clicked.add(actionId);
        const viewport = page.viewportSize();
        if (viewport === null) continue;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 750));
        await page.mouse.click(viewport.width - 280, viewport.height - 152).catch(() => undefined);
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
    }
  })();
  return {
    stop: () => {
      state.running = false;
    },
    askedOnce: () => state.asked,
  };
}

async function plannedLevels(turnId: string): Promise<string[]> {
  const rows = await pool.query<{ payload: { level?: string } }>(
    "SELECT payload FROM trajectory WHERE turn_id = $1 AND kind = 'action-planned' ORDER BY seq",
    [turnId],
  );
  return rows.rows.map((row) => row.payload.level ?? "L3");
}

async function reportOutcome(turnId: string): Promise<string | null> {
  const rows = await pool.query<{ payload: { kind: string; outcome?: string } }>(
    "SELECT payload FROM turn_event WHERE turn_id = $1 ORDER BY seq",
    [turnId],
  );
  return (
    rows.rows.map((row) => row.payload).find((event) => event.kind === "report")?.outcome ?? null
  );
}

async function startPanelTask(text: string): Promise<void> {
  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  const { width, height } = viewport as { width: number; height: number };
  await page.mouse.click(width - 32, height - 32);
  await page.mouse.click(width - 220, height - 100);
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
}

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
  await page.goto(`${app.origin}/settings/team`);
  const popup = await context.newPage();
  await popup.goto(
    `chrome-extension://${EXTENSION_ID}/popup.html?target=${encodeURIComponent(app.origin)}`,
  );
  await popup.getByTestId("activate").click();
  await expect(popup.getByTestId("tier")).toHaveText("Observing only");
  await popup.getByTestId("enable-control").click();
  await popup.getByTestId("confirm-control").click();
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

test("L1: the reviewed capability invites a teammate, confirmed once, predicate satisfied", async () => {
  test.setTimeout(360_000);
  const cutoff = new Date();
  await startPanelTask("Invite kim@example.com to the team.");
  const turnId = await newestTurnAfter(cutoff);
  const approver = approveAll(turnId);
  const status = await settledStatus(turnId);
  approver.stop();
  expect(approver.askedOnce()).toBe(true);
  expect(status).toBe("completed");
  expect(await reportOutcome(turnId)).toBe("completed");
  expect(await plannedLevels(turnId)).toContain("L1");
  const html = await (await fetch(`${app.origin}/settings/team`)).text();
  expect(html).toContain("kim@example.com");
});

test("L2: the reviewed route takes the page to billing", async () => {
  test.setTimeout(360_000);
  const cutoff = new Date();
  await startPanelTask("Take me to the billing settings page.");
  const turnId = await newestTurnAfter(cutoff);
  const approver = approveAll(turnId);
  const status = await settledStatus(turnId);
  approver.stop();
  expect(status).toBe("completed");
  expect(await reportOutcome(turnId)).toBe("completed");
  expect(await plannedLevels(turnId)).toContain("L2");
  await expect.poll(() => page.url(), { timeout: 15_000 }).toContain("/settings/billing");
});

test("L3 on variant B: the same grounded mechanism survives different markup", async () => {
  test.setTimeout(360_000);
  await page.goto(`${app.origin}/settings/profile?variant=b`);
  await expect(page.locator("#sga-root")).toHaveCount(1);
  const cutoff = new Date();
  await startPanelTask("Turn off the product updates preference and save the profile.");
  const turnId = await newestTurnAfter(cutoff);
  const approver = approveAll(turnId);
  const status = await settledStatus(turnId);
  approver.stop();
  expect(status).toBe("completed");
  expect(await reportOutcome(turnId)).toBe("completed");
  expect(await plannedLevels(turnId)).toContain("L3");
  const html = await (await fetch(`${app.origin}/settings/profile?variant=b`)).text();
  expect(html).not.toMatch(/name="updates"[^>]*checked/);
});

test("L3: a grounded action finishes a task no capability covers", async () => {
  test.setTimeout(360_000);
  await page.goto(`${app.origin}/settings/profile`);
  await expect(page.locator("#sga-root")).toHaveCount(1);
  const cutoff = new Date();
  await startPanelTask("Change the full name on this profile to Dana Reyes and save it.");
  const turnId = await newestTurnAfter(cutoff);
  const approver = approveAll(turnId);
  const status = await settledStatus(turnId);
  approver.stop();
  expect(approver.askedOnce()).toBe(true);
  expect(status).toBe("completed");
  expect(await reportOutcome(turnId)).toBe("completed");
  const levels = await plannedLevels(turnId);
  expect(levels).toContain("L3");
  const html = await (await fetch(`${app.origin}/settings/profile`)).text();
  expect(html).toContain("Dana Reyes");
});
