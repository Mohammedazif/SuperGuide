// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { PageDigest } from "@superguide/contract/anywhere";
import { classifyRisk, SENSITIVE_TERMS } from "./risk.js";

function digestWith(name: string, id = "e00000001"): PageDigest {
  return {
    url: "https://app.example.com/settings",
    title: "Settings",
    nodes: [
      {
        id,
        parentId: null,
        role: "button",
        name,
        state: { disabled: false },
        inViewport: true,
      },
    ],
  };
}

const digest: PageDigest = {
  url: "https://app.example.com/settings",
  title: "Settings",
  nodes: [
    {
      id: "e00000001",
      parentId: null,
      role: "button",
      name: "Save profile",
      state: { disabled: false },
      inViewport: true,
    },
    {
      id: "e00000002",
      parentId: null,
      role: "button",
      name: "Delete account",
      state: { disabled: false },
      inViewport: true,
    },
    {
      id: "e00000003",
      parentId: null,
      role: "button",
      name: "",
      state: { disabled: false },
      inViewport: true,
    },
  ],
};

describe("static risk classification", () => {
  it("classifies pure observation as read", () => {
    expect(classifyRisk({ kind: "readBack", target: { id: "e00000001" } }, digest)).toBe("read");
    expect(
      classifyRisk(
        {
          kind: "waitFor",
          predicate: { kind: "url-matches", contains: "/settings" },
          timeoutMs: 1000,
        },
        digest,
      ),
    ).toBe("read");
    expect(classifyRisk({ kind: "focus", target: { id: "e00000001" } }, digest)).toBe("read");
    expect(classifyRisk({ kind: "scrollIntoView", target: { id: "e00000001" } }, digest)).toBe(
      "read",
    );
  });

  it("classifies interaction with an ordinary named control as write", () => {
    expect(classifyRisk({ kind: "click", target: { id: "e00000001" } }, digest)).toBe("write");
    expect(classifyRisk({ kind: "type", target: { id: "e00000001" }, value: "x" }, digest)).toBe(
      "write",
    );
    expect(classifyRisk({ kind: "navigate", path: "/settings" }, digest)).toBe("write");
  });

  it("escalates to sensitive when the target's name signals money, access, or deletion", () => {
    expect(classifyRisk({ kind: "click", target: { id: "e00000002" } }, digest)).toBe("sensitive");
  });

  it("treats an unclassifiable target as write, never read or sensitive", () => {
    expect(classifyRisk({ kind: "click", target: { id: "e0000000f" } }, digest)).toBe("write");
    expect(classifyRisk({ kind: "click", target: { id: "e00000003" } }, digest)).toBe("write");
    expect(classifyRisk({ kind: "click", target: { id: "e00000001" } }, null)).toBe("write");
  });

  it("matches every sensitive term as a whole word", () => {
    for (const term of SENSITIVE_TERMS) {
      expect(
        classifyRisk(
          { kind: "click", target: { id: "e00000001" } },
          digestWith(`Continue ${term}`),
        ),
        term,
      ).toBe("sensitive");
    }
  });

  it("does not match sensitive terms as substrings", () => {
    expect(
      classifyRisk({ kind: "click", target: { id: "e00000001" } }, digestWith("Resettle filters")),
    ).toBe("write");
    expect(
      classifyRisk({ kind: "click", target: { id: "e00000001" } }, digestWith("Airplane mode")),
    ).toBe("write");
  });
});
