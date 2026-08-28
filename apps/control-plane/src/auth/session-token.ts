import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { identityTierSchema } from "@superguide/contract/public";

// Not a JWT: no alg header or iss/aud a customer API would honour.
const SESSION_TOKEN_PREFIX = "sgs1";

export const sessionClaimsSchema = z.object({
  productId: z.uuid(),
  endUserId: z.uuid(),
  tier: identityTierSchema,
  scopes: z.array(z.string()),
  externalId: z.string().nullable(),
  issuedAt: z.int(),
  expiresAt: z.int(),
});
export type SessionClaims = z.infer<typeof sessionClaimsSchema>;

export type SessionVerification =
  | { ok: true; claims: SessionClaims }
  | { ok: false; reason: "malformed" | "signature" | "expired" };

function base64url(input: Buffer): string {
  return input.toString("base64url");
}

function sign(key: Buffer, body: string): string {
  return base64url(createHmac("sha256", key).update(body).digest());
}

export function signSessionToken(key: Buffer, claims: SessionClaims): string {
  const body = `${SESSION_TOKEN_PREFIX}.${base64url(Buffer.from(JSON.stringify(claims), "utf8"))}`;
  return `${body}.${sign(key, body)}`;
}

export function verifySessionToken(
  key: Buffer,
  token: string,
  nowSeconds: number,
): SessionVerification {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [prefix, payload, signature] = parts;
  if (prefix !== SESSION_TOKEN_PREFIX || payload === undefined || signature === undefined) {
    return { ok: false, reason: "malformed" };
  }

  const expected = sign(key, `${prefix}.${payload}`);
  const provided = Buffer.from(signature);
  const computed = Buffer.from(expected);
  if (provided.length !== computed.length || !timingSafeEqual(provided, computed)) {
    return { ok: false, reason: "signature" };
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }

  const claims = sessionClaimsSchema.safeParse(decoded);
  if (!claims.success) return { ok: false, reason: "malformed" };
  if (claims.data.expiresAt <= nowSeconds) return { ok: false, reason: "expired" };
  return { ok: true, claims: claims.data };
}
