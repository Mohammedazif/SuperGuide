import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    trace: "retain-on-failure",
  },
  projects: [
    { name: "widget", testMatch: /widget\.spec\.ts/ },
    {
      name: "extension",
      testMatch: /extension\/.*\.spec\.ts/,
      timeout: 120_000,
    },
  ],
});
