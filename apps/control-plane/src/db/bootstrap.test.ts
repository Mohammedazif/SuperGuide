import { describe, expect, it } from "vitest";
import { parsePostgresUrl, postgresRoleName, quoteIdent, quoteLiteral } from "./bootstrap.js";

describe("hosted postgres URLs", () => {
  it("parses a local URL", () => {
    expect(parsePostgresUrl("postgres://sg_app:sg_app_dev@127.0.0.1:55432/superguide")).toEqual({
      user: "sg_app",
      password: "sg_app_dev",
      database: "superguide",
    });
  });

  it("parses a Supabase direct URL with encoded password and sslmode", () => {
    expect(
      parsePostgresUrl(
        "postgresql://sg_app:p%40ss@db.abc.supabase.co:5432/postgres?sslmode=require",
      ),
    ).toEqual({
      user: "sg_app",
      password: "p@ss",
      database: "postgres",
    });
  });
});

describe("pooler usernames", () => {
  it("strips the Supabase project ref suffix", () => {
    expect(postgresRoleName("sg_app")).toBe("sg_app");
    expect(postgresRoleName("sg_app.mijclvicetbzxlkkijdf")).toBe("sg_app");
    expect(postgresRoleName("postgres.abc")).toBe("postgres");
  });
});

describe("SQL quoting", () => {
  it("quotes identifiers and literals", () => {
    expect(quoteIdent("sg_app")).toBe('"sg_app"');
    expect(quoteIdent('weird"name')).toBe('"weird""name"');
    expect(quoteLiteral("p@ss")).toBe("'p@ss'");
    expect(quoteLiteral("o'reilly")).toBe("'o''reilly'");
  });
});
