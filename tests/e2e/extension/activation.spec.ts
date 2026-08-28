import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type BrowserContext, type Page, type Worker } from "@playwright/test";
import {
  extensionDistDir,
  EXTENSION_ID,
  launchWithExtension,
  serviceWorkerOf,
  stageExtension,
} from "./helpers/launch.js";
import { startSite, type FixtureSite } from "./helpers/site.js";

test.describe.configure({ mode: "serial" });

let context: BrowserContext;
let worker: Worker;
let siteA: FixtureSite;
let siteB: FixtureSite;
let pageA: Page;

const GRANTS_KEY = "sga.grants";

async function storedGrants(): Promise<{ origin: string; tier: string }[]> {
  return worker.evaluate(async (key) => {
    const stored = await chrome.storage.local.get(key);
    return (stored[key] ?? []) as { origin: string; tier: string }[];
  }, GRANTS_KEY);
}

async function openPopupFor(origin: string): Promise<Page> {
  const popup = await context.newPage();
  await popup.goto(
    `chrome-extension://${EXTENSION_ID}/popup.html?target=${encodeURIComponent(origin)}`,
  );
  return popup;
}

test.beforeAll(async () => {
  siteA = await startSite("127.0.0.1", "<h1>Fixture A</h1>");
  siteB = await startSite("localhost", "<h1>Fixture B</h1>");
  const staged = stageExtension(["http://127.0.0.1/*"]);
  context = await launchWithExtension(staged);
  worker = await serviceWorkerOf(context);
});

test.afterAll(async () => {
  await context.close();
  await siteA.close();
  await siteB.close();
});

test("the shipped manifest carries no host permissions and the worker loads", async () => {
  const shipped = JSON.parse(readFileSync(join(extensionDistDir(), "manifest.json"), "utf8")) as Record<
    string,
    unknown
  >;
  expect(shipped["host_permissions"]).toBeUndefined();
  expect(shipped["content_scripts"]).toBeUndefined();
  expect(await worker.evaluate(() => chrome.runtime.id)).toBe(EXTENSION_ID);
});

test("nothing is injected before activation", async () => {
  pageA = await context.newPage();
  await pageA.goto(siteA.origin);
  await pageA.waitForTimeout(600);
  expect(await pageA.locator("#sga-root").count()).toBe(0);
});

test("activation through the popup grants observe and injects the content script", async () => {
  const popup = await openPopupFor(siteA.origin);
  await popup.getByTestId("activate").click();
  await expect(popup.getByTestId("tier")).toHaveText("Observing only");
  await expect(pageA.locator("#sga-root")).toHaveCount(1);
  await pageA.reload();
  await expect(pageA.locator("#sga-root")).toHaveCount(1);
  expect(await storedGrants()).toEqual([
    { origin: siteA.origin, tier: "observe", grantedAt: expect.any(Number) },
  ]);
  await popup.close();
});

test("an origin that was never activated gets nothing", async () => {
  const pageB = await context.newPage();
  await pageB.goto(siteB.origin);
  await pageB.waitForTimeout(600);
  expect(await pageB.locator("#sga-root").count()).toBe(0);
  await pageB.close();
});

test("control requires its own two-step gesture", async () => {
  const popup = await openPopupFor(siteA.origin);
  await expect(popup.getByTestId("tier")).toHaveText("Observing only");
  await popup.getByTestId("enable-control").click();
  expect((await storedGrants())[0]?.tier).toBe("observe");
  await popup.getByTestId("confirm-control").click();
  await expect(popup.getByTestId("tier")).toHaveText("Can observe and act");
  expect((await storedGrants())[0]?.tier).toBe("control");
  await popup.close();
});

test("deactivation revokes the permission and removes the grant", async () => {
  const popup = await openPopupFor(siteA.origin);
  await popup.getByTestId("deactivate").click();
  await expect(popup.getByTestId("activate")).toBeVisible();
  expect(await storedGrants()).toEqual([]);
  // Chrome refuses to drop install-time host permissions; observe revocation via grant + injection.
  await pageA.reload();
  await pageA.waitForTimeout(600);
  expect(await pageA.locator("#sga-root").count()).toBe(0);
});
