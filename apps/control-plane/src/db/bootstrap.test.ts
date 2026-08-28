import { describe, expect, it } from "vitest";
import { postgresRoleName, quoteIdent, quoteLiteral } from "./bootstrap.js";

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
