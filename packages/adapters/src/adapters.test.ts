import { describe, expect, it } from "vitest";
import type { PageDigest, SiteAdapter } from "@superguide/contract/anywhere";
import { AdapterParseError, parseAdapter } from "./loader.js";
import { expandRouteTemplate, matchAdapter, matchRoute, resolveStepAction } from "./matcher.js";
import { pickAdapterSet } from "./cache.js";

const SAMPLE_YAML = [
  "host: app.example.com",
  "version: 3",
  "routes:",
  "  - id: billing.address",
  "    template: /settings/billing",
  "    params: []",
  "capabilities:",
  "  - id: seat.invite",
  "    description: Invite a teammate by email address",
  "    risk: write",
  "    route: /settings/team",
  "    params:",
  "      - name: email",
  "        description: Email address of the person to invite",
  "    steps:",
  "      - action: type",
  '        target: { role: textbox, name: "Email" }',
  "        value: { from: param, name: email }",
  "      - action: click",
  '        target: { role: button, name: "Invite member" }',
  "    expect:",
  "      - kind: element-present",
  '        target: { role: status, name: "Invitation sent" }',
  "",
].join("\n");

function adapter(overrides: Partial<SiteAdapter>): SiteAdapter {
  return {
    host: "app.example.com",
    version: 1,
    routes: [],
    capabilities: [],
    ...overrides,
  };
}

describe("the adapter loader", () => {
  it("parses a well-formed adapter", () => {
    const parsed = parseAdapter("sample.yaml", SAMPLE_YAML);
    expect(parsed.host).toBe("app.example.com");
    expect(parsed.capabilities.map((capability) => capability.id)).toEqual(["seat.invite"]);
    for (const capability of parsed.capabilities) {
      expect(capability.expect.length).toBeGreaterThan(0);
    }
  });

  it("rejects a capability without an expect predicate", () => {
    const text = SAMPLE_YAML.replace(/ {4}expect:\n(?: {6}.*\n?)+/g, "");
    expect(() => parseAdapter("no-expect.yaml", text)).toThrow(AdapterParseError);
  });

  it("rejects a route template with an undeclared param", () => {
    const text = [
      "host: app.example.com",
      "version: 1",
      "routes:",
      "  - id: user.profile",
      "    template: /users/{userId}",
      "    params: []",
      "capabilities: []",
    ].join("\n");
    expect(() => parseAdapter("bad-route.yaml", text)).toThrow(/undeclared param \{userId\}/);
  });

  it("rejects a step referencing an undeclared capability param", () => {
    const text = [
      "host: app.example.com",
      "version: 1",
      "routes: []",
      "capabilities:",
      "  - id: bad.cap",
      "    description: Uses a param it never declared",
      "    risk: write",
      "    route: /x",
      "    params: []",
      "    steps:",
      "      - action: type",
      '        target: { role: textbox, name: "Email" }',
      "        value: { from: param, name: email }",
      "    expect:",
      "      - kind: url-matches",
      "        contains: /x",
    ].join("\n");
    expect(() => parseAdapter("bad-cap.yaml", text)).toThrow(/undeclared param email/);
  });

  it("rejects YAML that is not an adapter at all", () => {
    expect(() => parseAdapter("junk.yaml", "just: a string map")).toThrow(AdapterParseError);
  });
});

describe("the host matcher", () => {
  it("matches by exact host only", () => {
    const set = [adapter({ host: "app.example.com" }), adapter({ host: "other.example.com" })];
    expect(matchAdapter(set, "app.example.com")?.host).toBe("app.example.com");
    expect(matchAdapter(set, "sub.app.example.com")).toBeNull();
    expect(matchAdapter(set, "example.com")).toBeNull();
  });

  it("breaks a host tie deterministically: highest version, whatever the order", () => {
    const older = adapter({ version: 2 });
    const newer = adapter({ version: 5 });
    expect(matchAdapter([older, newer], "app.example.com")?.version).toBe(5);
    expect(matchAdapter([newer, older], "app.example.com")?.version).toBe(5);
  });

  it("breaks an identical-version tie deterministically, whatever the order", () => {
    const left = adapter({ routes: [{ id: "a.route", template: "/a", params: [] }] });
    const right = adapter({ routes: [{ id: "b.route", template: "/b", params: [] }] });
    const forward = matchAdapter([left, right], "app.example.com");
    const backward = matchAdapter([right, left], "app.example.com");
    expect(forward).toEqual(backward);
  });
});

describe("the route matcher", () => {
  const site = adapter({
    routes: [
      { id: "root", template: "/", params: [] },
      { id: "settings", template: "/settings", params: [] },
      { id: "settings.billing", template: "/settings/billing", params: [] },
      { id: "user.detail", template: "/users/{userId}", params: ["userId"] },
    ],
  });

  it("prefers the longest static prefix", () => {
    expect(matchRoute(site, "/settings/billing")?.id).toBe("settings.billing");
    expect(matchRoute(site, "/settings/team")?.id).toBe("settings");
    expect(matchRoute(site, "/users/42")?.id).toBe("user.detail");
    expect(matchRoute(site, "/elsewhere")?.id).toBe("root");
  });

  it("breaks an equal-length tie by the smallest id, whatever the order", () => {
    const tied = adapter({
      routes: [
        { id: "zebra", template: "/x", params: [] },
        { id: "alpha", template: "/x", params: [] },
      ],
    });
    expect(matchRoute(tied, "/x")?.id).toBe("alpha");
    const reversed = adapter({ routes: [...tied.routes].reverse() });
    expect(matchRoute(reversed, "/x")?.id).toBe("alpha");
  });

  it("expands a template with url-encoded params and refuses a missing one", () => {
    const route = { id: "user.detail", template: "/users/{userId}", params: ["userId"] };
    expect(expandRouteTemplate(route, [{ name: "userId", value: "a b/c" }])).toEqual({
      ok: true,
      value: "/users/a%20b%2Fc",
    });
    expect(expandRouteTemplate(route, [])).toEqual({
      ok: false,
      error: "route user.detail needs the param userId",
    });
  });
});

describe("step resolution against a digest", () => {
  const digest: PageDigest = {
    url: "http://127.0.0.1:1/settings/team",
    title: "Team",
    nodes: [
      {
        id: "e00000001",
        parentId: null,
        role: "textbox",
        name: "Email",
        state: { disabled: false },
        inViewport: true,
      },
      {
        id: "e00000002",
        parentId: null,
        role: "button",
        name: "Invite member",
        state: { disabled: false },
        inViewport: true,
      },
    ],
  };

  it("resolves targets to synthetic ids and params to values", () => {
    expect(
      resolveStepAction(
        { action: "type", target: { role: "textbox", name: "Email" }, value: { from: "param", name: "email" } },
        [{ name: "email", value: "kim@example.com" }],
        digest,
      ),
    ).toEqual({
      ok: true,
      value: { kind: "type", target: { id: "e00000001" }, value: "kim@example.com" },
    });
    expect(
      resolveStepAction(
        { action: "click", target: { role: "button", name: "Invite member" } },
        [],
        digest,
      ),
    ).toEqual({ ok: true, value: { kind: "click", target: { id: "e00000002" } } });
    expect(resolveStepAction({ action: "navigate", route: "/settings/team" }, [], digest)).toEqual({
      ok: true,
      value: { kind: "navigate", path: "/settings/team" },
    });
    expect(
      resolveStepAction(
        {
          action: "waitFor",
          predicate: { kind: "element-present", target: { role: "link", name: "Connections" } },
        },
        [],
        digest,
      ),
    ).toEqual({
      ok: true,
      value: {
        kind: "waitFor",
        predicate: { kind: "element-present", target: { role: "link", name: "Connections" } },
        timeoutMs: 15_000,
      },
    });
  });

  it("fails honestly when the target or the param is absent", () => {
    const missingTarget = resolveStepAction(
      { action: "click", target: { role: "button", name: "Vanished" } },
      [],
      digest,
    );
    expect(missingTarget.ok).toBe(false);
    const missingParam = resolveStepAction(
      { action: "type", target: { role: "textbox", name: "Email" }, value: { from: "param", name: "email" } },
      [],
      digest,
    );
    expect(missingParam.ok).toBe(false);
  });
});

describe("the adapter set cache rule", () => {
  const cachedNewer = { version: 9, adapters: [] };
  const served = { version: 3, adapters: [] };

  it("discards a cached set newer than the server's", () => {
    expect(pickAdapterSet(cachedNewer, served)).toEqual(served);
  });

  it("falls back to the cache only when the server did not answer", () => {
    expect(pickAdapterSet(cachedNewer, null)).toEqual(cachedNewer);
    expect(pickAdapterSet(null, null)).toBeNull();
  });
});
