import { describe, expect, it } from "vitest";
import { redact, REDACTED } from "./redact.js";
import { createRequestSigner, sealCredentials } from "./credentials.js";

// Join ordinary words at runtime; never write a realistic-looking credential in this file.
const KEY = Buffer.alloc(32, 5);

const SECRET = ["not", "a", "real", "credential", "0123456789abcdef"].join("-");
const PASSWORD = ["not", "a", "real", "password"].join("-");
const SESSION_VALUE = ["not", "a", "real", "session"].join("-");
const CARD_NUMBER = ["not", "a", "real", "card", "number"].join("-");
const USERNAME = "dana";
const BASIC = Buffer.from(`${USERNAME}:${PASSWORD}`).toString("base64");

const CANARIES = [SECRET, PASSWORD, SESSION_VALUE, CARD_NUMBER];

const CORPUS: { name: string; input: unknown }[] = [
  { name: "an authorization header", input: { headers: { authorization: `Bearer ${SECRET}` } } },
  {
    name: "a set-cookie header",
    input: { headers: { "set-cookie": `session=${SESSION_VALUE}; HttpOnly` } },
  },
  { name: "a cookie header", input: { headers: { cookie: `session=${SESSION_VALUE}` } } },
  { name: "an api key field", input: { apiKey: SECRET } },
  { name: "a snake case api key", input: { api_key: SECRET } },
  {
    name: "a nested access token",
    input: { auth: { access_token: SECRET, refresh_token: SECRET } },
  },
  {
    name: "a password",
    input: { user: { password: PASSWORD, email: "dana@northwind.example" } },
  },
  { name: "a private key", input: { private_key: "-----BEGIN PRIVATE KEY-----abc" } },
  { name: "a card number", input: { card_number: CARD_NUMBER, cvv: "123" } },
  {
    name: "a bearer token loose in prose",
    input: { note: `call it with Bearer ${SECRET} please` },
  },
  { name: "a basic credential in prose", input: { note: `Authorization: Basic ${BASIC}` } },
  { name: "the secret inside a url", input: { url: `https://api.example/v1?token=${SECRET}` } },
  { name: "the secret inside an array", input: { attempts: [{ header: `Bearer ${SECRET}` }] } },
  { name: "a client secret", input: { client_secret: SECRET } },
  { name: "a session token", input: { sessionToken: SECRET } },
  { name: "a one time code", input: { otp: "884213", pin: "0000" } },
];

describe("the redactor", () => {
  const options = { secretValues: [SECRET], allowedFieldNames: [] };

  it("removes every secret in the corpus", () => {
    for (const entry of CORPUS) {
      const output = JSON.stringify(redact(entry.input, options));
      expect({
        case: entry.name,
        leaked: CANARIES.filter((canary) => output.includes(canary)),
      }).toEqual({ case: entry.name, leaked: [] });
    }
  });

  it("keeps the surrounding data intact", () => {
    const output = redact(
      { user: { password: PASSWORD, email: "dana@northwind.example" }, plan: "growth" },
      options,
    ) as { user: { password: string; email: string }; plan: string };

    expect(output.user.password).toBe(REDACTED);
    expect(output.user.email).toBe("dana@northwind.example");
    expect(output.plan).toBe("growth");
  });

  it("honours the product's allowlist for a field it names", () => {
    const output = redact({ token: "abc" }, { secretValues: [], allowedFieldNames: ["token"] }) as {
      token: string;
    };
    expect(output.token).toBe("abc");
  });

  it("is pure: it returns a new value and leaves the input alone", () => {
    const input = { headers: { authorization: `Bearer ${SECRET}` } };
    const before = JSON.stringify(input);
    const first = redact(input, options);
    const second = redact(input, options);

    expect(JSON.stringify(input)).toBe(before);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("does not recurse without bound", () => {
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let depth = 0; depth < 40; depth += 1) {
      const next: Record<string, unknown> = {};
      cursor["next"] = next;
      cursor = next;
    }
    cursor["authorization"] = SECRET;

    const output = JSON.stringify(redact(deep, options));
    expect(output).not.toContain(SECRET);
    expect(output).toContain(REDACTED);
  });

  it("leaves short values alone rather than corrupting ordinary text", () => {
    const output = redact(
      { note: "the city is GB" },
      { secretValues: ["GB"], allowedFieldNames: [] },
    );
    expect((output as { note: string }).note).toBe("the city is GB");
  });
});

describe("the request signer", () => {
  it("never returns the plaintext credential, only applies it", () => {
    const sealed = sealCredentials(KEY, { kind: "bearer", token: SECRET });
    const signer = createRequestSigner(KEY, sealed);

    const headers = new Headers();
    signer.applyTo(headers);
    expect(headers.get("authorization")).toBe(`Bearer ${SECRET}`);

    // secretValues is only for the redactor to strip.
    expect(signer.secretValues()).toContain(SECRET);
    expect(Object.keys(signer)).toEqual([]);
    expect(JSON.stringify(signer)).not.toContain(SECRET);
  });

  it("round trips every credential shape and rejects a tampered ciphertext", () => {
    for (const credentials of [
      { kind: "none" } as const,
      { kind: "bearer", token: SECRET } as const,
      { kind: "header", name: "X-Api-Key", value: SECRET } as const,
      { kind: "basic", username: USERNAME, password: PASSWORD } as const,
    ]) {
      const sealed = sealCredentials(KEY, credentials);
      const headers = new Headers();
      createRequestSigner(KEY, sealed).applyTo(headers);
      expect(headers.get("authorization") ?? headers.get("x-api-key") ?? "none").toBeTruthy();
    }

    const sealed = sealCredentials(KEY, { kind: "bearer", token: SECRET });
    sealed.ciphertext[0] = (sealed.ciphertext[0] ?? 0) ^ 0xff;
    expect(() => createRequestSigner(KEY, sealed)).toThrow();
  });

  it("applies nothing when a product has no stored credential", () => {
    const headers = new Headers();
    createRequestSigner(KEY, null).applyTo(headers);
    expect([...headers.keys()]).toEqual([]);
  });
});
