import { describe, expect, it } from "vitest";
import { productionSourceFiles } from "../helpers/source-files";

/**
 * Plans are DEACTIVATED, never deleted: every payment ever recorded on a plan
 * references it, and deleting one would orphan the record of money that
 * actually changed hands. There is no delete action, and this fails the build
 * if application code ever grows one. (Test code is not scanned: integration
 * tests legitimately clean up the scratch plans they create.) The database
 * backs this up independently — see the integration test that a plan with
 * payment history cannot be deleted at all.
 */
const DELETES_PLANS = /paymentPlan\s*\.\s*(delete|deleteMany)\b|delete\s+from\s+"?PaymentPlan"?/i;

export function deletesPlans(text: string): boolean {
  return DELETES_PLANS.test(text);
}

describe("payment plans are never deleted", () => {
  it("REQUIRED: no production code deletes a PaymentPlan", () => {
    const offenders = productionSourceFiles()
      .filter(({ text }) => deletesPlans(text))
      .map(({ file }) => file);

    expect(offenders, "deactivate a plan (`active: false`) instead — see plan-actions.ts").toEqual([]);
  });

  describe("the scanner can actually flag a deletion (positive controls)", () => {
    it("flags the Prisma delete calls", () => {
      expect(deletesPlans("await prisma.paymentPlan.delete({ where: { id } });")).toBe(true);
      expect(deletesPlans("await tx.paymentPlan.deleteMany({ where: { academyId } });")).toBe(true);
    });

    it("flags raw SQL", () => {
      expect(deletesPlans('await prisma.$executeRaw`DELETE FROM "PaymentPlan" WHERE id = ${id}`;')).toBe(true);
    });

    it("does not flag deactivating a plan", () => {
      expect(deletesPlans("await tx.paymentPlan.update({ where: { id }, data: { active: false } });")).toBe(false);
    });
  });
});
