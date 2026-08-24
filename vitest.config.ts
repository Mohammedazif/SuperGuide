import { defineConfig } from "vitest/config";

const databaseProject = (name: string, include: string[]) => ({
  test: {
    name,
    include,
    environment: "node" as const,
    globalSetup: ["./tests/helpers/global-setup.ts"],
    hookTimeout: 60_000,
    testTimeout: 60_000,
    fileParallelism: false,
  },
});

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: [
            "packages/*/src/**/*.test.{ts,tsx}",
            "apps/*/src/**/*.test.{ts,tsx}",
          ],
          environment: "node",
        },
      },
      databaseProject("integration", ["tests/integration/**/*.test.ts"]),
      databaseProject("security", ["tests/security/**/*.test.ts"]),
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["packages/policy/src/**"],
      thresholds: { branches: 100, functions: 100, lines: 100, statements: 100 },
    },
  },
});
