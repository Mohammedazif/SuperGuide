import { describe, expect, it } from "vitest";
import { parsePostgresUrl, pgConnectOptions } from "./connect.js";

describe("parsePostgresUrl", () => {
  it("parses a local URL", () => {
    expect(parsePostgresUrl("postgres://sg_app:sg_app_dev@127.0.0.1:55432/superguide")).toEqual({
      user: "sg_app",
      password: "sg_app_dev",
      host: "127.0.0.1",
      port: 55432,
      database: "superguide",
    });
  });

  it("parses a pooler URL with an encoded password", () => {
    expect(
      parsePostgresUrl(
        "postgresql://sg_app.abc:p%40ss@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres?sslmode=require",
      ),
    ).toEqual({
      user: "sg_app.abc",
      password: "p@ss",
      host: "aws-0-ap-northeast-1.pooler.supabase.com",
      port: 5432,
      database: "postgres",
    });
  });
});

describe("pgConnectOptions", () => {
  it("does not enable TLS on local URLs and does not pass connectionString", () => {
    const options = pgConnectOptions("postgres://sg_app:x@127.0.0.1:55432/superguide");
    expect(options).toEqual({
      host: "127.0.0.1",
      port: 55432,
      user: "sg_app",
      password: "x",
      database: "superguide",
    });
    expect(options).not.toHaveProperty("connectionString");
    expect(options).not.toHaveProperty("ssl");
  });

  it("enables TLS without CA verification on the Supabase pooler", () => {
    const options = pgConnectOptions(
      "postgresql://sg_app.abc:x@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres?sslmode=require",
    );
    expect(options.ssl).toEqual({ rejectUnauthorized: false });
    expect(options).not.toHaveProperty("connectionString");
  });
});
