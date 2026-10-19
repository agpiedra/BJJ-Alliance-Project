import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * /dev/belts and /dev/components are dev-only previews. Under NODE_ENV=production each page must call notFound()
 * before reading any data or translations (belts) or rendering anything (components). The compiled-build behavior —
 * real HTTP 404 in both locales, including under `next start` with NODE_ENV=test — is checked by
 * scripts/verify-production-build.ts.
 */
const NOT_FOUND = new Error("NEXT_NOT_FOUND (test sentinel)");
const notFound = vi.fn(() => {
  throw NOT_FOUND;
});
const findUnique = vi.fn(async () => ({ id: "org-1" }));
const findMany = vi.fn(async () => []);
const getTranslations = vi.fn(async () => (key: string) => key);

vi.mock("next/navigation", () => ({ notFound: () => notFound() }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    organization: { findUnique: () => findUnique() },
    beltRank: { findMany: () => findMany() },
  },
}));
vi.mock("next-intl/server", () => ({ getTranslations: () => getTranslations() }));

const { default: DevBeltsPage } = await import("../../src/app/[locale]/dev/belts/page");
const { default: DevComponentsPage } = await import("../../src/app/[locale]/dev/components/page");

const params = { params: Promise.resolve({ locale: "en" }) };

beforeEach(() => {
  notFound.mockClear();
  findUnique.mockClear();
  findMany.mockClear();
  getTranslations.mockClear();
});
afterEach(() => vi.unstubAllEnvs());

describe("dev preview pages under NODE_ENV=production", () => {
  beforeEach(() => vi.stubEnv("NODE_ENV", "production"));

  it("/dev/belts calls notFound() before any translation or database read", async () => {
    await expect(DevBeltsPage(params)).rejects.toBe(NOT_FOUND);
    expect(notFound).toHaveBeenCalledTimes(1);
    expect(getTranslations).not.toHaveBeenCalled();
    expect(findUnique).not.toHaveBeenCalled();
    expect(findMany).not.toHaveBeenCalled();
  });

  it("/dev/components calls notFound() instead of rendering", () => {
    expect(() => DevComponentsPage()).toThrow(NOT_FOUND);
    expect(notFound).toHaveBeenCalledTimes(1);
  });
});

describe("dev preview pages outside production", () => {
  beforeEach(() => vi.stubEnv("NODE_ENV", "development"));

  it("/dev/belts reads its data and renders", async () => {
    expect(await DevBeltsPage(params)).toBeTruthy();
    expect(notFound).not.toHaveBeenCalled();
    expect(findUnique).toHaveBeenCalledTimes(1);
  });

  it("/dev/components renders", () => {
    expect(DevComponentsPage()).toBeTruthy();
    expect(notFound).not.toHaveBeenCalled();
  });
});
