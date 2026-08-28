import { describe, expect, it } from "vitest";
import { pgConnectOptions } from "./connect.js";

describe("pgConnectOptions", () => {
  it("does not force TLS on local URLs", () => {
    expect(pgConnectOptions("postgres://sg_app:x@127.0.0.1:55432/superguide")).toEqual({
      connectionString: "postgres://sg_app:x@127.0.0.1:55432/superguide",
    });
  });

  it("disables CA verification on Supabase pooler URLs", () => {
    const url =
      "postgresql://sg_app.abc:x@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres?sslmode=require";
    expect(pgConnectOptions(url)).toEqual({
      connectionString: url,
      ssl: { rejectUnauthorized: false },
    });
  });
});
