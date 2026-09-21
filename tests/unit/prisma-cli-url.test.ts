import { describe, expect, it } from "vitest";
import { resolveCliDatabaseUrl } from "../../scripts/lib/prisma-cli-url";

const POOLED_SUPABASE = "postgresql://postgres.abcdefgh:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres";
// A remote DIRECT_URL must state its certificate handling (see the guard tests below).
const DIRECT_SUPABASE =
  "postgresql://postgres:pw@db.abcdefgh.supabase.co:5432/postgres?sslmode=require&sslaccept=strict&sslcert=/certs/supabase-ca.crt";

describe("resolveCliDatabaseUrl — which connection the Prisma CLI (migrations) uses", () => {
  it("falls back to DATABASE_URL when DIRECT_URL is unset — local dev and CI behave exactly as before", () => {
    const url = "postgresql://alliance:pw@localhost:5432/alliance_bjj";
    expect(resolveCliDatabaseUrl({ DATABASE_URL: url })).toBe(url);
  });

  it("treats an empty DIRECT_URL (a blank line in .env) as unset, not as a URL", () => {
    const url = "postgresql://alliance:pw@localhost:5432/alliance_bjj";
    expect(resolveCliDatabaseUrl({ DATABASE_URL: url, DIRECT_URL: "" })).toBe(url);
    expect(resolveCliDatabaseUrl({ DATABASE_URL: url, DIRECT_URL: "   " })).toBe(url);
  });

  it("prefers DIRECT_URL for a legitimate pooled/direct pair — the same database reached two ways", () => {
    expect(resolveCliDatabaseUrl({ DATABASE_URL: POOLED_SUPABASE, DIRECT_URL: DIRECT_SUPABASE })).toBe(DIRECT_SUPABASE);
  });

  it("ignores query strings and a trailing slash when comparing database names", () => {
    const pooled = "postgresql://u:p@pooler.example:6543/appdb?sslmode=require";
    const direct = "postgresql://u:p@db.example:5432/appdb/?sslaccept=strict";
    expect(resolveCliDatabaseUrl({ DATABASE_URL: pooled, DIRECT_URL: direct })).toBe(direct);
  });

  it("returns DIRECT_URL alone when DATABASE_URL is absent (a machine that only runs migrations)", () => {
    expect(resolveCliDatabaseUrl({ DIRECT_URL: DIRECT_SUPABASE })).toBe(DIRECT_SUPABASE);
  });

  it("returns undefined when neither is set, leaving Prisma to report the missing URL itself", () => {
    expect(resolveCliDatabaseUrl({})).toBeUndefined();
  });

  it("REQUIRED: refuses when DIRECT_URL and DATABASE_URL name different databases — the stale-DIRECT_URL-vs-test-redirect hazard", () => {
    // A script redirected DATABASE_URL to the test database while a
    // production DIRECT_URL was still in the shell. Without this refusal
    // the CLI would silently migrate production.
    const redirectedToTestDb = "postgresql://alliance:pw@localhost:5433/alliance_bjj_test";
    expect(() => resolveCliDatabaseUrl({ DATABASE_URL: redirectedToTestDb, DIRECT_URL: DIRECT_SUPABASE })).toThrow(
      /Refusing to run the Prisma CLI: DIRECT_URL names database "postgres" but DATABASE_URL names "alliance_bjj_test"/,
    );
  });

  it("names the fix in the refusal so the person hitting it at 11pm can act on it", () => {
    expect(() =>
      resolveCliDatabaseUrl({
        DATABASE_URL: "postgresql://a:b@localhost:5433/alliance_bjj_test",
        DIRECT_URL: "postgresql://a:b@localhost:5432/alliance_bjj",
      }),
    ).toThrow(/unset DIRECT_URL for that command/);
  });

  describe("a remote DIRECT_URL must state its certificate handling", () => {
    // Verified against a real TLS Postgres with a private CA: on the Prisma
    // CLI path `sslmode=require` AND `sslmode=verify-full` connected with a
    // WRONG CA. Only `sslaccept=strict` verifies. A URL that reads as
    // "verified" and isn't is exactly the silent failure this refuses.
    const remote = "postgresql://postgres:pw@db.abcdefgh.supabase.co:5432/postgres";

    it("REQUIRED: refuses a remote DIRECT_URL with no sslaccept — even one that says sslmode=verify-full", () => {
      for (const query of ["", "?sslmode=require", "?sslmode=verify-full", "?sslmode=verify-full&sslcert=/certs/ca.crt"]) {
        expect(() => resolveCliDatabaseUrl({ DIRECT_URL: `${remote}${query}` }), query).toThrow(/sets no sslaccept/);
      }
    });

    it("names the fix: sslaccept=strict with sslcert, and the explicit fallback", () => {
      expect(() => resolveCliDatabaseUrl({ DIRECT_URL: remote })).toThrow(/sslaccept=strict&sslcert=<path to the database CA file>/);
      expect(() => resolveCliDatabaseUrl({ DIRECT_URL: remote })).toThrow(/sslaccept=accept_invalid_certs/);
    });

    it("accepts sslaccept=strict (verification) and accept_invalid_certs (an explicit, knowing fallback)", () => {
      const strict = `${remote}?sslmode=require&sslaccept=strict&sslcert=/certs/ca.crt`;
      const lax = `${remote}?sslmode=require&sslaccept=accept_invalid_certs`;
      expect(resolveCliDatabaseUrl({ DIRECT_URL: strict })).toBe(strict);
      expect(resolveCliDatabaseUrl({ DIRECT_URL: lax })).toBe(lax);
    });

    it("applies the same rule when DATABASE_URL is also set", () => {
      expect(() => resolveCliDatabaseUrl({ DATABASE_URL: POOLED_SUPABASE, DIRECT_URL: remote })).toThrow(/sets no sslaccept/);
    });

    it("does not apply to a local DIRECT_URL", () => {
      const local = "postgresql://alliance:pw@localhost:5432/alliance_bjj";
      expect(resolveCliDatabaseUrl({ DIRECT_URL: local })).toBe(local);
    });

    it("does not apply to the DATABASE_URL fallback — `prisma generate` loads this file with a remote URL and never connects", () => {
      expect(resolveCliDatabaseUrl({ DATABASE_URL: POOLED_SUPABASE })).toBe(POOLED_SUPABASE);
    });
  });

  it("reports WHICH variable is malformed rather than a bare 'Invalid URL'", () => {
    expect(() => resolveCliDatabaseUrl({ DATABASE_URL: POOLED_SUPABASE, DIRECT_URL: "not a url" })).toThrow(
      "DIRECT_URL is not a valid connection URL.",
    );
    expect(() => resolveCliDatabaseUrl({ DATABASE_URL: "also not a url", DIRECT_URL: DIRECT_SUPABASE })).toThrow(
      "DATABASE_URL is not a valid connection URL.",
    );
  });
});
