import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { expect, test, type BrowserContext, type Page, type Worker } from "@playwright/test";
import {
  EXTENSION_ID,
  REPO_ROOT,
  launchWithExtension,
  serviceWorkerOf,
  stageExtension,
} from "./helpers/launch.js";
import { spawnControlPlane, type ControlPlaneProcess } from "./helpers/control-plane-process.js";
import { startSite, type FixtureSite } from "./helpers/site.js";

test.describe.configure({ mode: "serial" });

let context: BrowserContext;
let worker: Worker;
let server: ControlPlaneProcess;
let site: FixtureSite;
let page: Page;
let turnId: string;

interface TurnRecord {
  turnId: string;
  lastSeq: number;
  delivered: number;
}

async function respondsQuickly(candidate: Worker): Promise<boolean> {
  // Evaluating on a terminated worker hangs forever rather than rejecting, so liveness
  // is decided by a race against a short timeout.
  const probe = candidate
    .evaluate(() => 1)
    .then(
      () => true,
      () => false,
    );
  const timeout = new Promise<boolean>((resolveProbe) =>
    setTimeout(() => {
      resolveProbe(false);
    }, 800),
  );
  return Promise.race([probe, timeout]);
}

async function liveWorker(): Promise<Worker> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    for (const candidate of context.serviceWorkers()) {
      if (await respondsQuickly(candidate)) return candidate;
    }
    if (Date.now() > deadline) throw new Error("no live service worker");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
  }
}

async function readTurnRecords(): Promise<TurnRecord[]> {
  const current = await liveWorker();
  return current.evaluate(async () => {
    const everything = await chrome.storage.session.get(null);
    return Object.entries(everything)
      .filter(([key]) => key.startsWith("sga.turn."))
      .map(([, value]) => value as { turnId: string; lastSeq: number; delivered: number });
  });
}

async function pollForRecord(
  predicate: (record: TurnRecord) => boolean,
  timeoutMs: number,
): Promise<TurnRecord> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const records = await readTurnRecords();
    const match = records.find(predicate);
    if (match !== undefined) return match;
    if (Date.now() > deadline) {
      throw new Error(`no turn record matched within ${timeoutMs}ms: ${JSON.stringify(records)}`);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
}

function emitEvents(count: number, start: number): void {
  const result = spawnSync(
    "node",
    [
      "--import",
      "tsx",
      join(REPO_ROOT, "tests/e2e/extension/helpers/emit-events.ts"),
      turnId,
      String(count),
      String(start),
    ],
    { encoding: "utf8", cwd: REPO_ROOT },
  );
  expect(result.status, result.stderr).toBe(0);
}

test.beforeAll(async () => {
  server = await spawnControlPlane();
  site = await startSite("127.0.0.1", "<h1>Resume fixture</h1>");
  const staged = stageExtension(["http://127.0.0.1/*"]);
  context = await launchWithExtension(staged);
  worker = await serviceWorkerOf(context);
  await worker.evaluate(
    (base) => chrome.storage.local.set({ "sga.apiBase": base }),
    server.baseUrl,
  );
  page = await context.newPage();
  await page.goto(site.origin);
  const popup = await context.newPage();
  await popup.goto(
    `chrome-extension://${EXTENSION_ID}/popup.html?target=${encodeURIComponent(site.origin)}`,
  );
  await popup.getByTestId("activate").click();
  await expect(popup.getByTestId("tier")).toHaveText("Observing only");
  await popup.close();
  await expect(page.locator("#sga-root")).toHaveCount(1);
});

test.afterAll(async () => {
  await context.close();
  await site.close();
  await server.stop();
});

test("a task starts a turn and events reach the extension in order", async () => {
  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  const { width, height } = viewport as { width: number; height: number };

  await page.mouse.click(width - 32, height - 32);
  await page.mouse.click(width - 220, height - 100);
  await page.keyboard.type("prove the stream survives");
  await page.keyboard.press("Enter");

  const record = await pollForRecord(() => true, 15_000);
  turnId = record.turnId;

  emitEvents(3, 0);
  const advanced = await pollForRecord(
    (candidate) => candidate.turnId === turnId && candidate.lastSeq === 2,
    15_000,
  );
  expect(advanced.delivered).toBe(3);
});

test("service worker termination mid-turn: resume with no duplicate and no gap", async () => {
  const browser = context.browser();
  expect(browser, "persistent context must expose its browser for CDP").not.toBeNull();
  if (browser === null) return;
  const cdp = await browser.newBrowserCDPSession();
  const { targetInfos } = (await cdp.send("Target.getTargets")) as {
    targetInfos: { targetId: string; type: string; url: string }[];
  };
  const workerTarget = targetInfos.find(
    (info) => info.type === "service_worker" && info.url.includes(EXTENSION_ID),
  );
  expect(workerTarget, "the extension service worker target must exist").toBeDefined();
  if (workerTarget === undefined) return;
  await worker.evaluate(() => {
    (globalThis as unknown as { __sgaEpoch: string }).__sgaEpoch = "before-termination";
  });
  const closed = await cdp.send("Target.closeTarget", {
    targetId: workerTarget.targetId,
  });
  expect(closed.success).toBe(true);

  const revived = await liveWorker();
  const epoch = await revived.evaluate(
    () => (globalThis as unknown as { __sgaEpoch?: string }).__sgaEpoch,
  );
  expect(epoch, "a fresh worker instance must have started").toBeUndefined();

  emitEvents(3, 3);

  const resumed = await pollForRecord(
    (candidate) => candidate.turnId === turnId && candidate.lastSeq === 5,
    30_000,
  );
  expect(resumed.delivered).toBe(6);
});
