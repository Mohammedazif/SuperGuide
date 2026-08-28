import { spawnSync } from "node:child_process";
import { join } from "node:path";
import pg from "pg";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import {
  EXTENSION_ID,
  REPO_ROOT,
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

test.describe.configure({ mode: "serial" });

let server: ControlPlaneProcess;
let app: FixtureAppProcess;
let context: BrowserContext;
let page: Page;
let pool: pg.Pool;

const VIEW = { width: 1280, height: 720 };

function emitAction(turnId: string, path: string): string {
  const result = spawnSync(
    "node",
    ["--import", "tsx", join(REPO_ROOT, "tests/e2e/extension/helpers/emit-action.ts"), turnId, path],
    { encoding: "utf8", cwd: REPO_ROOT },
  );
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

async function newestTurn(after?: Date): Promise<string> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const rows = await pool.query<{ id: string }>(
      "SELECT id FROM turn WHERE created_at > $1 ORDER BY created_at DESC LIMIT 1",
      [after ?? new Date(0)],
    );
    const found = rows.rows[0]?.id;
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error("no turn was created");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
}

async function actionResultCount(actionId: string): Promise<number> {
  const rows = await pool.query("SELECT 1 FROM action_result WHERE action_id = $1", [actionId]);
  return rows.rowCount ?? 0;
}

test.beforeAll(async () => {
  pool = new pg.Pool({ connectionString: appDatabaseUrl() });
  server = await spawnControlPlane();
  app = await spawnFixtureApp();
  const staged = stageExtension(["http://127.0.0.1/*"]);
  context = await launchWithExtension(staged);
  const worker = await serviceWorkerOf(context);
  await worker.evaluate(
    (base) => chrome.storage.local.set({ "sga.apiBase": base }),
    server.baseUrl,
  );
  page = await context.newPage();
});

test.afterAll(async () => {
  await context.close();
  await app.stop();
  await server.stop();
  await pool.end();
});

test("the UI renders under the fixture app's strict CSP, header byte-identical", async () => {
  const headerSeen = new Promise<string | null>((resolveHeader) => {
    page.on("response", (response) => {
      if (response.url() === `${app.origin}/settings/billing`) {
        resolveHeader(response.headers()["content-security-policy"] ?? null);
      }
    });
  });
  await page.goto(`${app.origin}/settings/billing`);

  const served = await fetch(`${app.origin}/settings/billing`);
  const expected = served.headers.get("content-security-policy");
  expect(expected).not.toBeNull();
  expect(expected).toContain("default-src");
  expect(await headerSeen).toBe(expected);

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
  await page.mouse.click(VIEW.width - 32, VIEW.height - 32);
  await page.mouse.click(VIEW.width - 220, VIEW.height - 100);
  await page.keyboard.type("prove the panel accepts input under this CSP");
  await page.keyboard.press("Enter");
  await newestTurn();
});

test("stop takes effect before the next action, not after the turn", async () => {
  const turnId = await newestTurn();

  const first = emitAction(turnId, "/settings/profile");
  await expect.poll(() => page.url(), { timeout: 15_000 }).toContain("/settings/profile");
  await expect.poll(() => actionResultCount(first), { timeout: 15_000 }).toBe(1);

  // Navigate result lands before the new document; wait for re-injected host or the click misses.
  await page.locator("#sga-root").waitFor({ state: "attached", timeout: 10_000 });
  await page.mouse.click(VIEW.width - 32, VIEW.height - 32);
  await page.mouse.click(VIEW.width - 54, VIEW.height - 528);

  const second = emitAction(turnId, "/settings/plan");
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 3_000));
  expect(page.url()).toContain("/settings/profile");
  expect(await actionResultCount(second)).toBe(0);
});

test("a mid-turn downgrade to observe stops the next action, not the turn after", async () => {
  await page.goto(`${app.origin}/settings/profile`);
  await expect(page.locator("#sga-root")).toHaveCount(1);
  const cutoff = new Date();
  await page.mouse.click(VIEW.width - 32, VIEW.height - 32);
  await page.mouse.click(VIEW.width - 220, VIEW.height - 100);
  await page.keyboard.type("prove the downgrade lands before the next action");
  await page.keyboard.press("Enter");
  const turnId = await newestTurn(cutoff);

  const first = emitAction(turnId, "/settings/team");
  await expect.poll(() => page.url(), { timeout: 15_000 }).toContain("/settings/team");
  await expect.poll(() => actionResultCount(first), { timeout: 15_000 }).toBe(1);

  const popup = await context.newPage();
  await popup.goto(
    `chrome-extension://${EXTENSION_ID}/popup.html?target=${encodeURIComponent(app.origin)}`,
  );
  await popup.getByTestId("drop-observe").click();
  await expect(popup.getByTestId("tier")).toHaveText("Observing only");
  await popup.close();

  const second = emitAction(turnId, "/settings/plan");
  await expect.poll(() => actionResultCount(second), { timeout: 15_000 }).toBe(1);
  const rows = await pool.query<{ result: { status: string; reason?: string } }>(
    "SELECT result FROM action_result WHERE action_id = $1",
    [second],
  );
  expect(rows.rows[0]?.result).toMatchObject({
    status: "refused",
    reason: "grant_insufficient",
  });
  expect(page.url()).toContain("/settings/team");
});

test("the quota display reflects a server-side change with no extension rebuild", async () => {
  const popup = await context.newPage();
  await popup.goto(
    `chrome-extension://${EXTENSION_ID}/popup.html?target=${encodeURIComponent(app.origin)}`,
  );
  await expect(popup.getByTestId("quota")).toContainText("of 20 tasks used today");
  await popup.close();

  const port = server.port;
  await server.stop();
  server = await spawnControlPlane({ port, dailyTaskQuota: "5" });

  const reopened = await context.newPage();
  await reopened.goto(
    `chrome-extension://${EXTENSION_ID}/popup.html?target=${encodeURIComponent(app.origin)}`,
  );
  await expect(reopened.getByTestId("quota")).toContainText("of 5 tasks used today");
  await reopened.close();
});
