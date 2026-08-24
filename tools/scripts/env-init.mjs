// Writes .env from .env.example, generating a fresh value for every key the example
// leaves blank. The example ships blank because a signing key committed to a repository
// is a signing key everybody has; this script is the reason that costs nobody any effort.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const EXAMPLE = join(REPO_ROOT, ".env.example");
const TARGET = join(REPO_ROOT, ".env");

// Exactly the variables the environment schema declares as base64 keys.
const GENERATED = new Map([
  ["SG_SESSION_SIGNING_KEY", 32],
  ["SG_SECRET_ENCRYPTION_KEY", 32],
  ["SG_WEBHOOK_SIGNING_KEY", 32],
]);

const force = process.argv.includes("--force");

if (existsSync(TARGET) && !force) {
  process.stderr.write(".env already exists. Pass --force to overwrite it.\n");
  process.exit(1);
}

const filled = [];
const output = readFileSync(EXAMPLE, "utf8")
  .split("\n")
  .map((line) => {
    const match = /^([A-Z0-9_]+)=$/.exec(line);
    if (match === null) return line;

    const bytes = GENERATED.get(match[1]);
    if (bytes === undefined) return line;

    filled.push(match[1]);
    return `${match[1]}=${randomBytes(bytes).toString("base64")}`;
  })
  .join("\n");

writeFileSync(TARGET, output, { mode: 0o600 });

process.stdout.write(`Wrote .env with ${filled.length} generated keys: ${filled.join(", ")}\n`);

// Anything still blank needs a human. Say so by name rather than letting the server
// fail at boot with a schema error the reader has to map back to a file.
const blank = output.split("\n").flatMap((line) => /^([A-Z0-9_]+)=$/.exec(line)?.[1] ?? []);

if (blank.length > 0) {
  process.stdout.write(`Still to fill in by hand: ${blank.join(", ")}\n`);
}
