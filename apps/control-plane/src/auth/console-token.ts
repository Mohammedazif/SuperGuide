import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

// A different prefix from a widget session token, carried in a cookie rather than a bearer
// header. A widget token can never be presented here and a console token can never be
// presented to a widget route.
const CONSOLE_TOKEN_PREFIX = "sgc1";
export const CONSOLE_COOKIE = "sg_console";

export const consoleClaimsSchema = z.object({
  operatorEmail: z.email(),
  tenantId: z.uuid(),
  issuedAt: z.int(),
  expiresAt: z.int(),
});
export type ConsoleClaims = z.infer<typeof consoleClaimsSchema>;

export type ConsoleVerification =
  | { ok: true; claims: ConsoleClaims }
  | { ok: false; reason: "malformed" | "signature" | "expired" };

function sign(key: Buffer, body: string): string {
  return createHmac("sha256", key).update(body).digest("base64url");
}

export function signConsoleToken(key: Buffer, claims: ConsoleClaims): string {
  const body = `${CONSOLE_TOKEN_PREFIX}.${Buffer.from(JSON.stringify(claims), "utf8").toString("base64url")}`;
  return `${body}.${sign(key, body)}`;
}

export function verifyConsoleToken(
  key: Buffer,
  token: string,
  nowSeconds: number,
): ConsoleVerification {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [prefix, payload, signature] = parts;
  if (prefix !== CONSOLE_TOKEN_PREFIX || payload === undefined || signature === undefined) {
    return { ok: false, reason: "malformed" };
  }

  const expected = Buffer.from(sign(key, `${prefix}.${payload}`), "utf8");
  const provided = Buffer.from(signature, "utf8");
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    return { ok: false, reason: "signature" };
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }

  const claims = consoleClaimsSchema.safeParse(decoded);
  if (!claims.success) return { ok: false, reason: "malformed" };
  if (claims.data.expiresAt <= nowSeconds) return { ok: false, reason: "expired" };
  return { ok: true, claims: claims.data };
}

export function readCookie(header: string | undefined, name: string): string | null {
  if (header === undefined) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}
