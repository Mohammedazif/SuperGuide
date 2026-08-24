import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import superguide from "eslint-plugin-superguide";

const NODE_BUILTINS = [
  "node:*",
  "fs",
  "path",
  "crypto",
  "http",
  "https",
  "net",
  "os",
  "child_process",
  "worker_threads",
  "timers",
  "url",
  "util",
  "stream",
  "zlib",
  "dns",
];

const NETWORK_GLOBALS = [
  { name: "fetch", message: "This package must never perform network I/O." },
  { name: "XMLHttpRequest", message: "This package must never perform network I/O." },
  { name: "WebSocket", message: "This package must never perform network I/O." },
  { name: "EventSource", message: "This package must never perform network I/O." },
  { name: "navigator", message: "This package must never perform network I/O." },
];

function boundary(files, restricted) {
  return {
    files,
    rules: {
      "no-restricted-imports": ["error", { patterns: restricted }],
    },
  };
}

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/.tsbuild/**",
      "**/coverage/**",
      "**/node_modules/**",
      "**/*.tsbuildinfo",
      "eval/results/**",
      "test-results/**",
      "playwright-report/**",
      "apps/fixture-app/public/**",
    ],
  },

  js.configs.recommended,
  prettier,

  {
    files: ["**/*.ts", "**/*.tsx"],
    extends: [...tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["apps/*/tsup.config.ts"],
          defaultProject: "tsconfig.json",
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { superguide },
    rules: {
      "superguide/no-vendor-names": "error",

      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
      "no-empty": ["error", { allowEmptyCatch: false }],
      "no-console": "error",

      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/switch-exhaustiveness-check": [
        "error",
        { considerDefaultExhaustiveForUnions: false, requireDefaultForNonUnion: true },
      ],
      "@typescript-eslint/explicit-module-boundary-types": "error",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true, allowBoolean: true },
      ],

      "no-restricted-properties": [
        "error",
        {
          object: "process",
          property: "env",
          message:
            "Read the environment only in the environment module, which validates it with Zod at process start.",
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "MemberExpression[object.name='document'][property.name=/^(write|writeln)$/]",
          message: "Never write into the host document.",
        },
        {
          selector: "CallExpression[callee.name='setTimeout'][arguments.0.type='Literal']",
          message: "setTimeout with a string body constructs code dynamically.",
        },
      ],
    },
  },

  {
    files: ["packages/**/*.ts", "packages/**/*.tsx"],
    rules: { "superguide/no-module-level-mutable-state": "error" },
  },

  boundary(
    ["packages/contract/**/*.ts"],
    [{ group: ["@superguide/*"], message: "contract is the root of the dependency graph." }],
  ),

  {
    files: ["packages/policy/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@superguide/*", "!@superguide/contract/public"],
              message: "policy may import only @superguide/contract/public.",
            },
            ...NODE_BUILTINS.map((g) => ({
              group: [g],
              message: "policy is pure: no node builtins.",
            })),
          ],
        },
      ],
      "no-restricted-globals": [
        "error",
        { name: "Date", message: "policy is pure: it may not read a clock." },
        { name: "performance", message: "policy is pure: it may not read a clock." },
        ...NETWORK_GLOBALS,
      ],
      "no-restricted-properties": [
        "error",
        { object: "Math", property: "random", message: "policy is pure: no randomness." },
        { object: "Date", property: "now", message: "policy is pure: it may not read a clock." },
        { object: "process", property: "env", message: "policy is pure: no environment access." },
      ],
      "no-restricted-syntax": [
        "error",
        { selector: "NewExpression[callee.name='Date']", message: "policy is pure: no clock." },
      ],
    },
  },

  {
    files: ["packages/procedures/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@superguide/*", "!@superguide/contract/public"],
              message: "procedures may import only @superguide/contract/public.",
            },
            ...NODE_BUILTINS.map((g) => ({
              group: [g],
              message: "procedures performs no I/O.",
            })),
          ],
        },
      ],
      "no-restricted-globals": ["error", ...NETWORK_GLOBALS],
    },
  },

  {
    files: ["packages/observer/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@superguide/*", "!@superguide/contract/public"],
              message: "observer may import only @superguide/contract/public.",
            },
            ...NODE_BUILTINS.map((g) => ({ group: [g], message: "observer runs in the browser." })),
          ],
        },
      ],
      "no-restricted-globals": ["error", ...NETWORK_GLOBALS],
    },
  },

  {
    files: ["packages/executor/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "@superguide/*",
                "!@superguide/contract/public",
                "!@superguide/observer",
              ],
              message: "executor may import only contract/public and observer.",
            },
            ...NODE_BUILTINS.map((g) => ({ group: [g], message: "executor runs in the browser." })),
          ],
        },
      ],
      "no-restricted-globals": ["error", ...NETWORK_GLOBALS],
    },
  },

  boundary(
    ["packages/client-core/**/*.ts"],
    [
      {
        group: ["@superguide/*", "!@superguide/contract/public", "!@superguide/executor"],
        message: "client-core may import only contract/public and executor.",
      },
    ],
  ),

  boundary(
    ["packages/widget-ui/**/*.ts", "packages/widget-ui/**/*.tsx"],
    [
      {
        group: ["@superguide/*", "!@superguide/contract/public", "!@superguide/client-core"],
        message: "widget-ui may import only contract/public and client-core.",
      },
    ],
  ),

  boundary(
    ["apps/control-plane/**/*.ts"],
    [
      {
        group: [
          "@superguide/*",
          "!@superguide/contract/public",
          "!@superguide/contract/internal",
          "!@superguide/policy",
          "!@superguide/procedures",
        ],
        message:
          "control-plane may import only contract, policy, and procedures. Browser packages are out of bounds.",
      },
    ],
  ),

  {
    files: ["apps/control-plane/src/env.ts", "tools/**/*.mjs", "tools/**/*.js"],
    rules: { "no-restricted-properties": "off" },
  },

  {
    files: ["apps/control-plane/src/**/*.ts"],
    ignores: ["apps/control-plane/src/db/client.ts", "apps/control-plane/src/db/migrate.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.property.name='transaction']",
          message: "Open transactions through withProduct so sg.product_id is always set.",
        },
      ],
    },
  },

  {
    files: ["tools/**/*.mjs", "tools/**/*.js", "*.config.js"],
    languageOptions: { globals: { process: "readonly", console: "readonly" } },
    plugins: { superguide },
    rules: { "no-console": "off", "superguide/no-vendor-names": "error" },
  },

  {
    files: [
      "tools/eslint-plugin-superguide/rules/vendor-list.js",
      "tools/scripts/check-forbidden.mjs",
    ],
    rules: { "superguide/no-vendor-names": "off" },
  },

  {
    files: ["**/*.test.ts", "**/*.spec.ts", "**/tests/**/*.ts", "eval/**/*.ts"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "no-restricted-properties": "off",
    },
  },
);
