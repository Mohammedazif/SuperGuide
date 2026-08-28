import { createHmac, timingSafeEqual } from "node:crypto";
import { deviceTokenClaimsSchema, type DeviceTokenClaims } from "@superguide/contract/internal";

const TOKEN_TTL_SECONDS = 12 * 60 * 60;

function hmac(payload: string, key: Buffer): Buffer {
  return createHmac("sha256", key).update(payload).digest();
}

export function signDeviceToken(
  deviceId: string,
  key: Buffer,
  nowSeconds: number,
): { token: string; claims: DeviceTokenClaims } {
  const claims: DeviceTokenClaims = {
    deviceId,
    issuedAt: nowSeconds,
    expiresAt: nowSeconds + TOKEN_TTL_SECONDS,
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = hmac(payload, key).toString("base64url");
  return { token: `${payload}.${signature}`, claims };
}

export function verifyDeviceToken(
  token: string,
  key: Buffer,
  nowSeconds: number,
): DeviceTokenClaims | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, signature] = parts;
  if (payload === undefined || signature === undefined) return null;
  const expected = hmac(payload, key);
  const provided = Buffer.from(signature, "base64url");
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const claims = deviceTokenClaimsSchema.safeParse(decoded);
  if (!claims.success) return null;
  if (claims.data.expiresAt <= nowSeconds) return null;
  return claims.data;
}
