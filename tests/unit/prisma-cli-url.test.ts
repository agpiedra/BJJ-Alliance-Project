import { describe, expect, it } from "vitest";
import { resolveCliDatabaseUrl } from "../../scripts/lib/prisma-cli-url";

const POOLED_SUPABASE = "postgresql://postgres.abcdefgh:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres";
const DIRECT_SUPABASE = "postgresql://postgres:pw@db.abcdefgh.supabase.co:5432/postgres";

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
    const direct = "postgresql://u:p@db.example:5432/appdb/";
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

  it("reports WHICH variable is malformed rather than a bare 'Invalid URL'", () => {
    expect(() => resolveCliDatabaseUrl({ DATABASE_URL: POOLED_SUPABASE, DIRECT_URL: "not a url" })).toThrow(
      "DIRECT_URL is not a valid connection URL.",
    );
    expect(() => resolveCliDatabaseUrl({ DATABASE_URL: "also not a url", DIRECT_URL: DIRECT_SUPABASE })).toThrow(
      "DATABASE_URL is not a valid connection URL.",
    );
  });
});
