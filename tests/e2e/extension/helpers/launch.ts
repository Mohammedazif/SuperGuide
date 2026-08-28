import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type BrowserContext, type Worker } from "@playwright/test";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
export const EXTENSION_ID = "ghdcebndlanhmdeajdbbemcaihpenhoj";

export function anywhereRoot(): string {
  return resolve(process.env["SUPERGUIDE_ANYWHERE_ROOT"] ?? join(REPO_ROOT, "..", "superguide-anywhere"));
}

export function extensionDistDir(): string {
  return join(anywhereRoot(), "apps/extension/dist");
}

export function stageExtension(preHeldHosts: readonly string[]): string {
  const dist = extensionDistDir();
  if (!existsSync(join(dist, "manifest.json"))) {
    throw new Error(
      `extension is not built at ${dist}. Build SuperGuide-Anywhere or set SUPERGUIDE_ANYWHERE_ROOT.`,
    );
  }
  const staged = mkdtempSync(join(tmpdir(), "sga-ext-"));
  cpSync(dist, staged, { recursive: true });
  if (preHeldHosts.length > 0) {
    const manifest = JSON.parse(readFileSync(join(staged, "manifest.json"), "utf8")) as Record<
      string,
      unknown
    >;
    manifest["host_permissions"] = [...preHeldHosts];
    writeFileSync(join(staged, "manifest.json"), JSON.stringify(manifest, null, 2));
  }
  return staged;
}

export async function launchWithExtension(staged: string): Promise<BrowserContext> {
  const profile = mkdtempSync(join(tmpdir(), "sga-profile-"));
  return chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${staged}`, `--load-extension=${staged}`],
  });
}

export async function serviceWorkerOf(context: BrowserContext): Promise<Worker> {
  const existing = context.serviceWorkers()[0];
  return existing ?? (await context.waitForEvent("serviceworker"));
}
