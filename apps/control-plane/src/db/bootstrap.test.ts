import { describe, expect, it } from "vitest";
import {
  alterLoginPasswordSql,
  createLoginRoleSql,
  postgresRoleName,
  quoteIdent,
  quoteLiteral,
} from "./bootstrap.js";

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

describe("hosted role SQL", () => {
  it("creates and updates a login without BYPASSRLS flags", () => {
    expect(createLoginRoleSql("sg_app", "secret")).toBe(
      "CREATE ROLE \"sg_app\" LOGIN PASSWORD 'secret'",
    );
    expect(alterLoginPasswordSql("sg_app", "secret")).toBe(
      "ALTER ROLE \"sg_app\" LOGIN PASSWORD 'secret'",
    );
    expect(createLoginRoleSql("sg_app", "secret")).not.toMatch(/BYPASSRLS|SUPERUSER|CREATEDB/i);
    expect(alterLoginPasswordSql("sg_app", "secret")).not.toMatch(/BYPASSRLS|SUPERUSER|CREATEDB/i);
  });
});
