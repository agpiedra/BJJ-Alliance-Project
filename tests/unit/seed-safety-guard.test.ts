import { describe, expect, it } from "vitest";
import { assertSafeSeedTarget } from "../../scripts/lib/seed-safety-guard";

describe("assertSafeSeedTarget", () => {
  it("refuses a non-local, non-test host (e.g. a Neon/production-looking URL)", () => {
    expect(() =>
      assertSafeSeedTarget("postgresql://user:pass@ep-cool-name-12345.us-east-2.aws.neon.tech:5432/production"),
    ).toThrow(/Refusing to seed known-password accounts/);
  });

  it("refuses a non-local host even when the database name contains neither 'test' nor 'prod'", () => {
    expect(() => assertSafeSeedTarget("postgresql://user:pass@db.example.com:5432/alliance")).toThrow(
      /Refusing to seed known-password accounts/,
    );
  });

  it("allows localhost regardless of database name", () => {
    expect(() => assertSafeSeedTarget("postgresql://alliance:pw@localhost:5432/alliance_bjj")).not.toThrow();
  });

  it("allows 127.0.0.1 regardless of database name", () => {
    expect(() => assertSafeSeedTarget("postgresql://alliance:pw@127.0.0.1:5433/alliance_bjj_test")).not.toThrow();
  });

  it("allows a non-local host whose database name contains 'test'", () => {
    expect(() => assertSafeSeedTarget("postgresql://ci:pw@ci-runner-db:5432/alliance_bjj_test")).not.toThrow();
  });
});
