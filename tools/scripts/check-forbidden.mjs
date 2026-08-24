import { globSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { UNAMBIGUOUS_VENDOR_NAMES } from "../eslint-plugin-superguide/rules/vendor-list.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const SELF_EXCLUDED = new Set([
  "tools/scripts/check-forbidden.mjs",
  "tools/eslint-plugin-superguide/rules/vendor-list.js",
  "pnpm-lock.yaml",
]);

const SCAN_GLOBS = [
  "packages/*/src/**/*.{ts,tsx}",
  "apps/*/src/**/*.{ts,tsx}",
  "apps/*/migrations/**/*.sql",
  "eval/harness/src/**/*.ts",
  "tools/**/*.{js,mjs,sql}",
  "*.{js,ts,json,yml,yaml}",
  "packages/*/package.json",
  "apps/*/package.json",
];

const TEST_FILE = /(\.test\.ts|\.spec\.ts|\/tests\/|\/fixtures\/)/;

const escaped = UNAMBIGUOUS_VENDOR_NAMES.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

const RULES = [
  {
    id: "csp-manipulation",
    description: "Any read or write of a Content-Security-Policy header",
    pattern: /content-security-policy/i,
    // apps/fixture-app stands in for a customer's own site. It serves a strict policy so the
    // widget can be proved to work under one. The product itself never touches the header.
    exclude: [/^apps\/fixture-app\//],
  },
  {
    id: "dynamic-code",
    description: "eval, new Function, or any dynamic code construction",
    pattern: /(^|[^.\w])eval\s*\(|new\s+Function\s*\(|Function\s*\(\s*["'`][^"'`]*["'`]\s*\)/,
  },
  {
    id: "session-recorder",
    description: "A session replay or analytics recorder",
    pattern: /session[_-]?replay|record[_-]?session|session[_-]?record(er|ing)|dom[_-]?recorder/i,
  },
  {
    id: "symmetric-user-token",
    description: "A symmetric-key path that signs a token on behalf of a customer's user",
    pattern: /\bHS(256|384|512)\b/,
    allowLine: /REJECTED_JWT_ALGORITHMS/,
    skipTests: true,
  },
  {
    id: "module-level-approval-flag",
    description: "A module-level mutable approval, confirmation, or bypass flag",
    pattern: /^\s*(export\s+)?(let|var)\s+\w*(approv|confirm|bypass|allowAll|skipPolicy)\w*/i,
  },
  {
    id: "privileged-app-role",
    description: "A database role used by the application that owns tables or has BYPASSRLS",
    pattern: /(?<!NO)BYPASSRLS|OWNER\s+TO\s+sg_app|ALTER\s+TABLE\s+\w+\s+OWNER\s+TO\s+sg_app/i,
  },
  {
    id: "persisted-selector",
    description: "A raw selector string chosen by the model and persisted",
    pattern: /\b(cssSelector|css_selector|selectorPath|selector_path|xpath|xPath)\b/i,
  },
  {
    id: "empty-catch",
    description: "An empty catch block",
    pattern: /catch\s*(\([^)]*\))?\s*\{\s*\}/,
  },
  {
    id: "vendor-name",
    description: "Any third-party vendor name",
    pattern: new RegExp(`(?<![a-z0-9])(${escaped.join("|")})(?![a-z0-9])`, "i"),
    allowLine: /^\s*(import|export)\s.*from\s+["']|["']\s*:\s*["']\^?\d/,
  },
];

function collectFiles() {
  const files = new Set();
  for (const pattern of SCAN_GLOBS) {
    for (const match of globSync(pattern, { cwd: REPO_ROOT, exclude: ["**/node_modules/**", "**/dist/**"] })) {
      const rel = match.split("\\").join("/");
      if (!SELF_EXCLUDED.has(rel)) files.add(rel);
    }
  }
  return [...files].sort();
}

function main() {
  const files = collectFiles();
  const hits = [];
  const excluded = new Set();

  for (const file of files) {
    const isTest = TEST_FILE.test(file);
    const lines = readFileSync(join(REPO_ROOT, file), "utf8").split("\n");
    for (const rule of RULES) {
      if (rule.skipTests === true && isTest) continue;
      if (rule.exclude !== undefined && rule.exclude.some((pattern) => pattern.test(file))) {
        excluded.add(`${rule.id} <- ${String(rule.exclude)}`);
        continue;
      }
      lines.forEach((line, index) => {
        if (!rule.pattern.test(line)) return;
        if (rule.allowLine !== undefined && rule.allowLine.test(line)) return;
        hits.push({ file, line: index + 1, rule: rule.id, text: line.trim().slice(0, 140) });
      });
    }
  }

  console.log(`check:forbidden scanned ${files.length} files against ${RULES.length} rules`);
  for (const note of [...excluded].sort()) {
    console.log(`  scoped: ${note}`);
  }
  if (hits.length === 0) {
    console.log("no forbidden patterns found");
    return;
  }
  for (const hit of hits) {
    console.error(`${hit.file}:${hit.line}  [${hit.rule}]  ${hit.text}`);
  }
  console.error(`\n${hits.length} forbidden pattern hit(s)`);
  process.exit(1);
}

main();
