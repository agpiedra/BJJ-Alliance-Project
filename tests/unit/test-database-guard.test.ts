import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetGuardedTestDatabaseUrlCacheForTests,
  resolveGuardedTestDatabaseUrl,
} from "../../scripts/lib/test-database-guard";

const ORIGINAL_TEST_URL = process.env.TEST_DATABASE_URL;
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;

function restoreEnv() {
  if (ORIGINAL_TEST_URL === undefined) delete process.env.TEST_DATABASE_URL;
  else process.env.TEST_DATABASE_URL = ORIGINAL_TEST_URL;
  if (ORIGINAL_DATABASE_URL === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
}

describe("resolveGuardedTestDatabaseUrl", () => {
  beforeEach(() => {
    delete process.env.TEST_DATABASE_URL;
    delete process.env.DATABASE_URL;
    __resetGuardedTestDatabaseUrlCacheForTests();
  });
  afterEach(restoreEnv);

  it("refuses when TEST_DATABASE_URL is missing", () => {
    process.env.DATABASE_URL = "postgresql://alliance:pw@localhost:5432/alliance_bjj";
    expect(() => resolveGuardedTestDatabaseUrl()).toThrow(/TEST_DATABASE_URL is required/);
  });

  it("refuses a fake dev-looking URL that structurally matches DATABASE_URL", () => {
    process.env.DATABASE_URL = "postgresql://alliance:pw@localhost:5432/alliance_bjj";
    // Same host/port/database as DATABASE_URL, differing only by a trailing
    // slash and an extra query param — string-inequal, structurally equal.
    process.env.TEST_DATABASE_URL = "postgresql://alliance:pw@localhost:5432/alliance_bjj/?schema=public";
    expect(() => resolveGuardedTestDatabaseUrl()).toThrow(/same database as DATABASE_URL/);
  });

  it("refuses a URL whose database name doesn't look like a test database", () => {
    process.env.DATABASE_URL = "postgresql://alliance:pw@localhost:5432/alliance_bjj";
    process.env.TEST_DATABASE_URL = "postgresql://alliance:pw@localhost:5433/some_other_db";
    expect(() => resolveGuardedTestDatabaseUrl()).toThrow(/doesn't look like a test database/);
  });

  it("accepts a genuinely separate, test-named database", () => {
    process.env.DATABASE_URL = "postgresql://alliance:pw@localhost:5432/alliance_bjj";
    process.env.TEST_DATABASE_URL = "postgresql://alliance:pw@localhost:5433/alliance_bjj_test";
    expect(resolveGuardedTestDatabaseUrl()).toBe(process.env.TEST_DATABASE_URL);
  });

  it("accepts a test-named database even when DATABASE_URL is unset", () => {
    process.env.TEST_DATABASE_URL = "postgresql://alliance:pw@localhost:5433/alliance_bjj_test";
    expect(resolveGuardedTestDatabaseUrl()).toBe(process.env.TEST_DATABASE_URL);
  });
});
