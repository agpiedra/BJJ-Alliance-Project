import { describe, expect, it } from "vitest";
import { Prisma } from "@/generated/prisma/client";
import { isCheckableSlug, slugFeedback, slugify, SLUG_PATTERN } from "@/lib/organizations/slug";
import { isSlugConflict } from "@/lib/organizations/slug-conflict";

const known = (code: string, meta?: Record<string, unknown>) => new Prisma.PrismaClientKnownRequestError("boom", { code, clientVersion: "test", meta });
// The shape Prisma 7 + the pg driver adapter really produces (captured from a real unique violation on Organization.slug).
const adapterMeta = (modelName: string, index: string) => ({ modelName, driverAdapterError: { name: "DriverAdapterError", cause: { kind: "UniqueConstraintViolation", constraint: { index }, table: modelName } } });

describe("isCheckableSlug: the same rule the server's availability check and the registration schema enforce", () => {
  it.each([
    ["", false], ["a", false], ["ab", true], ["a-", true], ["harbor-jiu-jitsu", true], ["a".repeat(60), true], ["a".repeat(61), false], ["Has-Upper", false], ["has space", false], ["ñandú", false],
  ])("%j -> %s", (slug, expected) => {
    expect(isCheckableSlug(slug)).toBe(expected);
    expect(SLUG_PATTERN.test(slug)).toBe(expected);
  });

  it("everything slugify() produces is either empty, one character, or checkable (so the two can never disagree)", () => {
    for (const name of ["Harbor", "H", "", "Núñez Escalante", "   ", "!!!", "Alliance Jiu-Jitsu Costa Rica", "x".repeat(200)]) {
      const s = slugify(name);
      expect(s.length < 2 || isCheckableSlug(s), JSON.stringify(name)).toBe(true);
    }
  });
});

describe("slugFeedback: availability feedback describes ONLY the current valid slug", () => {
  const free = { slug: "harbor", available: true };
  const taken = { slug: "alliance-cr", available: false };

  it("says nothing for an empty or one-character slug, even when an older result exists or a check is pending", () => {
    for (const checked of [null, free, taken]) {
      for (const pending of [false, true]) {
        expect(slugFeedback("", checked, pending)).toBeNull();
        expect(slugFeedback("h", checked, pending)).toBeNull();
      }
    }
  });

  it("shows a result only when it belongs to the current slug", () => {
    expect(slugFeedback("harbor", free, false)).toBe("available");
    expect(slugFeedback("alliance-cr", taken, false)).toBe("taken");
    expect(slugFeedback("harbor", taken, false)).toBeNull(); // a result for ANOTHER slug is never shown
    expect(slugFeedback("harbor", taken, true)).toBe("checking");
    expect(slugFeedback("harbor-x", free, false)).toBeNull();
  });

  it("shows the current slug's own result even while another check is still queued", () => {
    expect(slugFeedback("harbor", free, true)).toBe("available");
  });

  it("says checking only for a valid current slug that has no answer yet", () => {
    expect(slugFeedback("harbor", null, true)).toBe("checking");
    expect(slugFeedback("harbor", null, false)).toBeNull();
  });
});

describe("isSlugConflict: only a unique violation on Organization.slug is a slug conflict", () => {
  it("recognises the real driver-adapter shape", () => {
    expect(isSlugConflict(known("P2002", adapterMeta("Organization", "Organization_slug_key")))).toBe(true);
  });

  it("recognises the legacy engine shape (meta.target lists the column)", () => {
    expect(isSlugConflict(known("P2002", { modelName: "Organization", target: ["slug"] }))).toBe(true);
    expect(isSlugConflict(known("P2002", { modelName: "Organization", target: "Organization_slug_key" }))).toBe(true);
  });

  it("does NOT match a unique violation on another constraint or another model (those must surface, not become slugTaken)", () => {
    expect(isSlugConflict(known("P2002", adapterMeta("Academy", "Academy_slug_key")))).toBe(false); // same column name, other model
    expect(isSlugConflict(known("P2002", adapterMeta("Organization", "Organization_other_key")))).toBe(false);
    expect(isSlugConflict(known("P2002", adapterMeta("BeltRank", "BeltRank_organizationId_track_code_key")))).toBe(false);
    expect(isSlugConflict(known("P2002", { modelName: "Organization", target: ["contactEmail"] }))).toBe(false);
    expect(isSlugConflict(known("P2002"))).toBe(false); // no meta at all: cannot be attributed to the slug
  });

  it("does NOT match other Prisma errors, plain errors or non-errors", () => {
    expect(isSlugConflict(known("P2003", adapterMeta("Organization", "Organization_slug_key")))).toBe(false); // foreign key, right meta
    expect(isSlugConflict(known("P2025"))).toBe(false);
    expect(isSlugConflict(new Error("Unique constraint failed on the constraint: `Organization_slug_key`"))).toBe(false); // right words, wrong type
    expect(isSlugConflict("P2002")).toBe(false);
    expect(isSlugConflict(null)).toBe(false);
    expect(isSlugConflict(undefined)).toBe(false);
  });
});
