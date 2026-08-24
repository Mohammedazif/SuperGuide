import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const INTERNAL_MARKER = "sg-contract-internal-boundary-marker";
const PUBLIC_MARKER = "sg-contract-public-boundary-marker";

const BUNDLES = ["apps/widget/dist/widget.js"];

function main() {
  let failures = 0;

  for (const relativePath of BUNDLES) {
    const absolute = join(REPO_ROOT, relativePath);
    if (!existsSync(absolute)) {
      console.error(`${relativePath}: bundle not built. Run pnpm build first.`);
      failures += 1;
      continue;
    }
    const source = readFileSync(absolute, "utf8");

    if (!source.includes(PUBLIC_MARKER)) {
      console.error(
        `${relativePath}: public marker absent. The check cannot prove anything about this bundle.`,
      );
      failures += 1;
    }
    if (source.includes(INTERNAL_MARKER)) {
      console.error(`${relativePath}: contains the contract/internal marker.`);
      failures += 1;
    } else {
      console.log(`${relativePath}: no contract/internal marker (${source.length} bytes)`);
    }
  }

  if (failures > 0) {
    console.error(`\n${failures} bundle boundary failure(s)`);
    process.exit(1);
  }
  console.log("bundle boundary intact");
}

main();
