import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The test-only local browser seam in `src/lib/dues/ledger/activation.ts` (O4 owner-flow verification). The production default
 * must stay closed: a production build never activates anything, whatever its environment; outside production it activates
 * only an organization explicitly listed AND only while the dev-only bypass secret is set. The compiled-output check lives in
 * scripts/verify-production-build.ts.
 */
async function freshActivation() {
  vi.resetModules();
  return (await import("../../src/lib/dues/ledger/activation")).inactiveLedgerActivation;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("inactiveLedgerActivation test-only seam", () => {
  it("is closed by default: no environment, no organization is active", async () => {
    vi.stubEnv("E2E_AUTH_BYPASS_SECRET", "");
    vi.stubEnv("E2E_LEDGER_ACTIVE_ORG_IDS", "");
    const activation = await freshActivation();
    expect(await activation.isActive("org-1")).toBe(false);
  });

  it("NODE_ENV=production: closed even with the secret AND the organization listed", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("E2E_AUTH_BYPASS_SECRET", "s3cret");
    vi.stubEnv("E2E_LEDGER_ACTIVE_ORG_IDS", "org-1");
    const activation = await freshActivation();
    expect(await activation.isActive("org-1")).toBe(false);
  });

  it("outside production: requires the bypass secret", async () => {
    vi.stubEnv("E2E_AUTH_BYPASS_SECRET", "");
    vi.stubEnv("E2E_LEDGER_ACTIVE_ORG_IDS", "org-1");
    const activation = await freshActivation();
    expect(await activation.isActive("org-1")).toBe(false);
  });

  it("outside production with the secret: only the listed organizations, exactly", async () => {
    vi.stubEnv("E2E_AUTH_BYPASS_SECRET", "s3cret");
    vi.stubEnv("E2E_LEDGER_ACTIVE_ORG_IDS", " org-1 , org-2 ,,");
    const activation = await freshActivation();
    expect(await activation.isActive("org-1")).toBe(true);
    expect(await activation.isActive("org-2")).toBe(true);
    expect(await activation.isActive("org-3")).toBe(false);
    expect(await activation.isActive("org")).toBe(false);
    expect(await activation.isActive("")).toBe(false);
  });
});
