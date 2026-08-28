import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadAdapterDirectory } from "./adapters-fs.js";

const ADAPTERS_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../../adapters");

describe("the shipped adapter directory", () => {
  it("parses cleanly and carries the fixture-app adapter", () => {
    const set = loadAdapterDirectory(ADAPTERS_DIR);
    expect(set.version).toBeGreaterThanOrEqual(1);
    const fixture = set.adapters.find((adapter) => adapter.host === "127.0.0.1");
    expect(fixture).toBeDefined();
    expect(fixture?.capabilities.map((capability) => capability.id)).toEqual([
      "seat.invite",
      "billing.update-address",
    ]);
    const notion = set.adapters.find((adapter) => adapter.host === "app.notion.com");
    expect(notion).toBeDefined();
    expect(notion?.routes).toEqual([]);
    expect(notion?.capabilities.map((capability) => capability.id)).toEqual([
      "settings.open",
      "slack.connect",
    ]);
    expect(notion?.capabilities[1]?.steps.map((step) => step.action)).toEqual([
      "waitFor",
      "click",
      "waitFor",
      "click",
      "waitFor",
      "click",
    ]);
    for (const adapter of set.adapters) {
      for (const capability of adapter.capabilities) {
        expect(capability.expect.length).toBeGreaterThan(0);
      }
    }
  });
});
