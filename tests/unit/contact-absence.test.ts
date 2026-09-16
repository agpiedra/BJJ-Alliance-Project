// contact-list.ts also exports listStudentsToContact from the same module
// (matching promotion-queue.ts's single-file layout), so importing it here
// transitively imports `@/lib/prisma` at module load — never actually
// connects for these tests (only the pure `isAbsentEnoughToContact` below is
// exercised), but the env var must exist.
import "dotenv/config";
import { describe, expect, it } from "vitest";
import { isAbsentEnoughToContact } from "@/lib/students/contact-list";

describe("isAbsentEnoughToContact", () => {
  it("fewer than the threshold is not yet a concern", () => {
    expect(isAbsentEnoughToContact(6, 7)).toBe(false);
  });

  it("exactly the threshold already qualifies", () => {
    expect(isAbsentEnoughToContact(7, 7)).toBe(true);
  });

  it("well past the threshold qualifies", () => {
    expect(isAbsentEnoughToContact(20, 7)).toBe(true);
  });

  it("never attended (null) always qualifies — at least as urgent as any real gap", () => {
    expect(isAbsentEnoughToContact(null, 7)).toBe(true);
  });
});
