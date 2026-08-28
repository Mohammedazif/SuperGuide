import { describe, expect, it } from "vitest";
import { hashIp, resetsAtOf, utcDayOf } from "./quota.js";

describe("quota day arithmetic", () => {
  it("keys usage by the UTC day", () => {
    expect(utcDayOf(new Date("2026-08-25T23:59:59Z"))).toBe("2026-08-25");
    expect(utcDayOf(new Date("2026-08-26T00:00:00Z"))).toBe("2026-08-26");
  });

  it("resets at the next UTC midnight, across month ends", () => {
    expect(resetsAtOf(new Date("2026-08-31T10:00:00Z"))).toBe("2026-09-01T00:00:00.000Z");
    expect(resetsAtOf(new Date("2026-12-31T23:00:00Z"))).toBe("2027-01-01T00:00:00.000Z");
  });

  it("stores addresses only as salted hashes", () => {
    const hashed = hashIp("203.0.113.9", "salt-a");
    expect(hashed).not.toContain("203");
    expect(hashed).toMatch(/^[0-9a-f]{64}$/);
    expect(hashIp("203.0.113.9", "salt-b")).not.toBe(hashed);
  });
});
