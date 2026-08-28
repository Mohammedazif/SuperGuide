import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signDeviceToken, verifyDeviceToken } from "./device-token.js";

const KEY = randomBytes(32);
const NOW = 1_700_000_000;

describe("device session token", () => {
  it("round-trips claims for the signing key", () => {
    const deviceId = randomUUID();
    const { token, claims } = signDeviceToken(deviceId, KEY, NOW);
    expect(verifyDeviceToken(token, KEY, NOW + 60)).toEqual(claims);
  });

  it("rejects a token signed with a different key", () => {
    const { token } = signDeviceToken(randomUUID(), KEY, NOW);
    expect(verifyDeviceToken(token, randomBytes(32), NOW)).toBeNull();
  });

  it("rejects a tampered payload", () => {
    const { token } = signDeviceToken(randomUUID(), KEY, NOW);
    const [payload, signature] = token.split(".") as [string, string];
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as Record<
      string,
      unknown
    >;
    claims["deviceId"] = randomUUID();
    const forged = `${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${signature}`;
    expect(verifyDeviceToken(forged, KEY, NOW)).toBeNull();
  });

  it("rejects an expired token", () => {
    const { token, claims } = signDeviceToken(randomUUID(), KEY, NOW);
    expect(verifyDeviceToken(token, KEY, claims.expiresAt)).toBeNull();
  });

  it("rejects garbage", () => {
    expect(verifyDeviceToken("not-a-token", KEY, NOW)).toBeNull();
    expect(verifyDeviceToken("a.b.c", KEY, NOW)).toBeNull();
  });
});
