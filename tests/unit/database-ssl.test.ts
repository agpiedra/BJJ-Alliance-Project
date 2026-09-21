import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveDatabaseSsl } from "../../src/lib/prisma/database-ssl";

const PEM = "-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----\n";
const CA_B64 = Buffer.from(PEM).toString("base64");

const POOLED = "postgresql://postgres.abcdefgh:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres";

afterEach(() => vi.restoreAllMocks());

describe("resolveDatabaseSsl — the one place TLS to the database is decided", () => {
  describe("DATABASE_SSL_CA_B64: full verification", () => {
    it("returns a verifying ssl option carrying the decoded CA", () => {
      expect(resolveDatabaseSsl(POOLED, { DATABASE_SSL_CA_B64: CA_B64 })).toEqual({ ca: PEM, rejectUnauthorized: true });
    });

    it("REQUIRED: refuses TLS parameters in the URL — pg lets them override the ssl option and would silently drop the CA", () => {
      // Verified against a real TLS Postgres: `?sslmode=verify-full` next to
      // ssl:{ca} failed "unable to verify the first certificate" — the CA
      // was discarded, not merged.
      for (const param of ["sslmode=verify-full", "sslmode=require", "sslmode=no-verify", "ssl=true", "sslrootcert=/x.crt", "uselibpqcompat=true"]) {
        expect(() => resolveDatabaseSsl(`${POOLED}?${param}`, { DATABASE_SSL_CA_B64: CA_B64 }), param).toThrow(
          /silently discard the CA/,
        );
      }
    });

    it("ignores unrelated URL parameters", () => {
      expect(resolveDatabaseSsl(`${POOLED}?schema=public&connect_timeout=10`, { DATABASE_SSL_CA_B64: CA_B64 })).toEqual({
        ca: PEM,
        rejectUnauthorized: true,
      });
    });

    it("REQUIRED: refuses an IP-address host — pg then validates the certificate against \"localhost\", so 'verified' would be a lie", () => {
      for (const host of ["10.0.0.5", "[::1]"]) {
        expect(() => resolveDatabaseSsl(`postgresql://u:p@${host}:5432/db`, { DATABASE_SSL_CA_B64: CA_B64 }), host).toThrow(
          /needs the database's DNS hostname/,
        );
      }
    });

    it("says what is wrong when the value is not a base64-encoded PEM file", () => {
      // The likely mistake: pasting the PEM text itself, or a truncated paste.
      for (const bad of [PEM, "bm90IGEgY2VydA==", "!!!not-base64!!!"]) {
        expect(() => resolveDatabaseSsl(POOLED, { DATABASE_SSL_CA_B64: bad }), bad).toThrow(/does not decode to a PEM certificate/);
      }
    });

    it("treats a blank value (an empty line in .env) as unset", () => {
      expect(resolveDatabaseSsl("postgresql://u:p@localhost:5432/db", { DATABASE_SSL_CA_B64: "  " })).toBeUndefined();
    });
  });

  describe("DATABASE_SSL_MODE=no-verify: the temporary fallback", () => {
    it("returns an encrypted-but-unverified option and WARNS, naming it temporary", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(resolveDatabaseSsl(POOLED, { DATABASE_SSL_MODE: "no-verify" })).toEqual({ rejectUnauthorized: false });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toMatch(/NOT verified[\s\S]*temporary fallback/);
    });

    it("refuses URL TLS parameters here too", () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(() => resolveDatabaseSsl(`${POOLED}?sslmode=require`, { DATABASE_SSL_MODE: "no-verify" })).toThrow(/Remove them/);
    });

    it("rejects any other mode — there is no quiet way to say 'disable' or 'require'", () => {
      for (const mode of ["disable", "require", "verify-full", "NO-VERIFY"]) {
        expect(() => resolveDatabaseSsl(POOLED, { DATABASE_SSL_MODE: mode }), mode).toThrow(/only value is "no-verify"/);
      }
    });
  });

  it("refuses both being set — a fallback must not silently sit next to the real thing", () => {
    expect(() => resolveDatabaseSsl(POOLED, { DATABASE_SSL_CA_B64: CA_B64, DATABASE_SSL_MODE: "no-verify" })).toThrow(/Set only one/);
  });

  describe("neither set", () => {
    it("REQUIRED: refuses a remote database in production — pg's default is PLAINTEXT and Supabase accepts it", () => {
      // Verified: against a server offering TLS, a URL with no sslmode and no
      // ssl option connected with pg_stat_ssl.ssl = false.
      expect(() => resolveDatabaseSsl(POOLED, { NODE_ENV: "production" })).toThrow(/Refusing to connect to "aws-0-us-east-1.pooler.supabase.com" without TLS/);
    });

    it("the refusal names both ways out: the CA, and the explicit fallback", () => {
      expect(() => resolveDatabaseSsl(POOLED, { NODE_ENV: "production" })).toThrow(/DATABASE_SSL_CA_B64/);
      expect(() => resolveDatabaseSsl(POOLED, { NODE_ENV: "production" })).toThrow(/DATABASE_SSL_MODE=no-verify/);
    });

    it("does not accept URL-borne TLS in production either — one way to configure it, not two that can disagree", () => {
      expect(() => resolveDatabaseSsl(`${POOLED}?sslmode=verify-full`, { NODE_ENV: "production" })).toThrow(/Refusing to connect/);
    });

    it("leaves a local database alone in production — `next build`/`next start` against docker in CI", () => {
      for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
        expect(resolveDatabaseSsl(`postgresql://u:p@${host}:5432/db`, { NODE_ENV: "production" }), host).toBeUndefined();
      }
    });

    it("leaves everything to pg outside production — dev and test behave exactly as before", () => {
      expect(resolveDatabaseSsl(POOLED, { NODE_ENV: "development" })).toBeUndefined();
      expect(resolveDatabaseSsl(POOLED, {})).toBeUndefined();
    });
  });

  it("names DATABASE_URL when it is malformed rather than a bare 'Invalid URL'", () => {
    expect(() => resolveDatabaseSsl("not a url", {})).toThrow("DATABASE_URL is not a valid connection URL.");
  });
});
