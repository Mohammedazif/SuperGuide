import { describe, expect, it } from "vitest";
import { parseEnvironment } from "./env.js";

const KEY = Buffer.alloc(32, 7).toString("base64");
const SECRET = Buffer.alloc(32, 9).toString("base64");

function base(overrides: Record<string, string | undefined> = {}) {
  return {
    SG_DATABASE_URL: "postgres://sg_app:x@127.0.0.1:55432/superguide",
    SG_PUBLIC_ORIGIN: "http://127.0.0.1:8080",
    ANTHROPIC_API_KEY: "test-key",
    SG_SESSION_SIGNING_KEY: KEY,
    SG_SECRET_ENCRYPTION_KEY: SECRET,
    SG_WEBHOOK_SIGNING_KEY: KEY,
    SG_DEVICE_SIGNING_KEY: KEY,
    SG_ALLOWED_EXTENSION_IDS: "chrome-extension://ghdcebndlanhmdeajdbbemcaihpenhoj",
    ...overrides,
  };
}

describe("hosted platform env defaults", () => {
  it("uses PORT when SG_PORT is unset", () => {
    const env = parseEnvironment(base({ PORT: "10000" }));
    expect(env.SG_PORT).toBe(10000);
  });

  it("keeps SG_PORT when both PORT and SG_PORT are set", () => {
    const env = parseEnvironment(base({ PORT: "10000", SG_PORT: "8080" }));
    expect(env.SG_PORT).toBe(8080);
  });

  it("uses RENDER_EXTERNAL_URL when SG_PUBLIC_ORIGIN is unset", () => {
    const env = parseEnvironment(
      base({ SG_PUBLIC_ORIGIN: undefined, RENDER_EXTERNAL_URL: "https://superguide.onrender.com" }),
    );
    expect(env.SG_PUBLIC_ORIGIN).toBe("https://superguide.onrender.com");
  });
});
