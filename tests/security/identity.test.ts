import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pino } from "pino";
import pg from "pg";
import {
  SignJWT,
  exportJWK,
  exportSPKI,
  generateKeyPair,
  type JWK,
  type KeyObject,
} from "jose";
import { createHmac } from "node:crypto";
import { AsymmetricIdentityVerifier } from "../../apps/control-plane/src/auth/jwt-verifier.js";
import { productSchema, type Product } from "@superguide/contract/internal";
import { createTestProduct } from "../helpers/server.js";
import { migrationDatabaseUrl } from "../helpers/database.js";

const ISSUER = "https://auth.northwind.example";
const AUDIENCE = "superguide:northwind";

interface KeyMaterial {
  privateKey: CryptoKey | KeyObject;
  publicJwk: JWK;
  spki: string;
}

async function rsaKeys(): Promise<KeyMaterial> {
  const pair = await generateKeyPair("RS256", { extractable: true });
  const publicJwk = await exportJWK(pair.publicKey);
  publicJwk.kid = "test-rsa-key";
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";
  return { privateKey: pair.privateKey, publicJwk, spki: await exportSPKI(pair.publicKey) };
}

function serveJwks(jwk: JWK): Promise<{ url: string; server: Server }> {
  return new Promise((resolve) => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ keys: [jwk] }));
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("no port");
      resolve({ url: `http://127.0.0.1:${String(address.port)}/jwks.json`, server });
    });
  });
}

async function loadProduct(productId: string, patch: Record<string, unknown>): Promise<Product> {
  const client = new pg.Client({ connectionString: migrationDatabaseUrl() });
  await client.connect();
  try {
    await client.query(
      "UPDATE product SET jwks_url = $1, jwt_issuer = $2, jwt_audience = $3, jwt_algorithms = $4 WHERE id = $5",
      [patch["jwks_url"], ISSUER, AUDIENCE, ["RS256", "EdDSA"], productId],
    );
    const row = await client.query("SELECT * FROM product WHERE id = $1", [productId]);
    const found = row.rows[0] as Record<string, unknown>;
    return productSchema.parse({
      id: found["id"],
      tenantId: found["tenant_id"],
      name: found["name"],
      originAllowlist: found["origin_allowlist"],
      jwksUrl: found["jwks_url"],
      jwtIssuer: found["jwt_issuer"],
      jwtAudience: found["jwt_audience"],
      jwtAlgorithms: found["jwt_algorithms"],
      routeRegistry: found["route_registry"],
      redactionAllowlist: found["redaction_allowlist"],
      groundedActionsEnabled: found["grounded_actions_enabled"],
      retentionDays: found["retention_days"],
      apiBaseUrl: found["api_base_url"],
      createdAt: (found["created_at"] as Date).toISOString(),
      deletedAt: null,
    });
  } finally {
    await client.end();
  }
}

describe("asymmetric identity", () => {
  let keys: KeyMaterial;
  let jwks: { url: string; server: Server };
  let product: Product;
  let verifier: AsymmetricIdentityVerifier;

  beforeAll(async () => {
    keys = await rsaKeys();
    jwks = await serveJwks(keys.publicJwk);
    const created = await createTestProduct();
    product = await loadProduct(created.productId, { jwks_url: jwks.url });
    verifier = new AsymmetricIdentityVerifier({
      logger: pino({ level: "silent" }),
      keyFor: () => Promise.resolve({ jwksUrl: product.jwksUrl, spki: keys.spki }),
    });
  });

  afterAll(() => {
    jwks.server.close();
  });

  const sign = (claims: Record<string, unknown>, expiresIn = "5m"): Promise<string> =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "test-rsa-key" })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject(typeof claims["sub"] === "string" ? claims["sub"] : "user_42")
      .setIssuedAt()
      .setExpirationTime(expiresIn)
      .sign(keys.privateKey);

  it("accepts a correctly signed token and reads its scopes", async () => {
    const token = await sign({ sub: "user_42", scope: "billing:read billing:write", role: "owner" });
    const outcome = await verifier.verify(product, token);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.identity.externalId).toBe("user_42");
    expect(outcome.identity.tier).toBe("verified");
    expect(outcome.identity.scopes).toEqual(["billing:read", "billing:write"]);
    expect(outcome.identity.claims["role"]).toBe("owner");
  });

  it("rejects a token signed with a symmetric key derived from the public key", async () => {
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        sub: "attacker",
        iss: ISSUER,
        aud: AUDIENCE,
        exp: Math.floor(Date.now() / 1000) + 600,
      }),
    ).toString("base64url");
    const signature = createHmac("sha256", keys.spki)
      .update(`${header}.${payload}`)
      .digest("base64url");

    const outcome = await verifier.verify(product, `${header}.${payload}.${signature}`);
    expect(outcome).toEqual({ ok: false, reason: "token_rejected" });
  });

  it("rejects an unsecured token", async () => {
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        sub: "attacker",
        iss: ISSUER,
        aud: AUDIENCE,
        exp: Math.floor(Date.now() / 1000) + 600,
      }),
    ).toString("base64url");

    const outcome = await verifier.verify(product, `${header}.${payload}.`);
    expect(outcome).toEqual({ ok: false, reason: "token_rejected" });
  });

  it("rejects an expired token", async () => {
    const token = await sign({ sub: "user_42" }, "-10m");
    const outcome = await verifier.verify(product, token);
    expect(outcome).toEqual({ ok: false, reason: "token_rejected" });
  });

  it("accepts a token that expired within the clock skew tolerance", async () => {
    const token = await new SignJWT({ sub: "user_42" })
      .setProtectedHeader({ alg: "RS256", kid: "test-rsa-key" })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject("user_42")
      .setIssuedAt(Math.floor(Date.now() / 1000) - 300)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 30)
      .sign(keys.privateKey);

    const outcome = await verifier.verify(product, token);
    expect(outcome.ok).toBe(true);
  });

  it("rejects a token for another audience", async () => {
    const token = await new SignJWT({ sub: "user_42" })
      .setProtectedHeader({ alg: "RS256", kid: "test-rsa-key" })
      .setIssuer(ISSUER)
      .setAudience("someone-elses-api")
      .setSubject("user_42")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(keys.privateKey);

    const outcome = await verifier.verify(product, token);
    expect(outcome).toEqual({ ok: false, reason: "token_rejected" });
  });

  it("rejects a token from another issuer", async () => {
    const token = await new SignJWT({ sub: "user_42" })
      .setProtectedHeader({ alg: "RS256", kid: "test-rsa-key" })
      .setIssuer("https://someone-else.example")
      .setAudience(AUDIENCE)
      .setSubject("user_42")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(keys.privateKey);

    expect(await verifier.verify(product, token)).toEqual({ ok: false, reason: "token_rejected" });
  });

  it("rejects a token whose algorithm is not configured for the product", async () => {
    const restricted: Product = { ...product, jwtAlgorithms: ["EdDSA"] };
    const token = await sign({ sub: "user_42" });
    expect(await verifier.verify(restricted, token)).toEqual({
      ok: false,
      reason: "token_rejected",
    });
  });

  it("refuses to verify when the product configures no asymmetric algorithm", async () => {
    const misconfigured: Product = { ...product, jwtAlgorithms: [] };
    const token = await sign({ sub: "user_42" });
    expect(await verifier.verify(misconfigured, token)).toEqual({
      ok: false,
      reason: "no_asymmetric_algorithm_configured",
    });
  });

  it("verifies against a stored public key when no JWKS url is configured", async () => {
    const local: Product = { ...product, jwksUrl: null };
    const localVerifier = new AsymmetricIdentityVerifier({
      logger: pino({ level: "silent" }),
      keyFor: () => Promise.resolve({ jwksUrl: null, spki: keys.spki }),
    });
    const token = await sign({ sub: "user_42" });
    expect((await localVerifier.verify(local, token)).ok).toBe(true);
  });
});
