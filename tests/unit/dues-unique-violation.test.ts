import { describe, expect, it } from "vitest";
import { Prisma } from "../../src/generated/prisma/client";
import { isUniqueViolationOn } from "../../src/lib/dues/ledger/unique-violation";

/**
 * Late-fee-assessment brief §6.3: a P2002 is not one thing. `recordDuesPayment` can now collide on DuesSettlement's partial unique
 * index OR DuesLateFee_obligationId_key — this must identify which, not blanket-label every P2002 as one of them. Deterministic
 * (constructs the error shape directly) rather than depending on winning a real database race, which the corresponding
 * integration test (tests/integration/late-fee-assessment.test.ts) also attempts on a best-effort basis.
 */
function p2002(meta: Record<string, unknown>): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "test", meta });
}

describe("isUniqueViolationOn", () => {
  it("identifies a DuesSettlement collision via modelName", () => {
    expect(isUniqueViolationOn(p2002({ modelName: "DuesSettlement", target: ["obligationId"] }), "DuesSettlement")).toBe(true);
    expect(isUniqueViolationOn(p2002({ modelName: "DuesSettlement", target: ["obligationId"] }), "DuesLateFee")).toBe(false);
  });

  it("identifies a DuesLateFee collision via modelName", () => {
    expect(isUniqueViolationOn(p2002({ modelName: "DuesLateFee", target: ["obligationId"] }), "DuesLateFee")).toBe(true);
    expect(isUniqueViolationOn(p2002({ modelName: "DuesLateFee", target: ["obligationId"] }), "DuesSettlement")).toBe(false);
  });

  it("falls back to the constraint name in target when modelName is absent (a raw-SQL-shaped P2002)", () => {
    expect(isUniqueViolationOn(p2002({ target: "DuesSettlement_one_active_per_obligation_key" }), "DuesSettlement")).toBe(true);
    expect(isUniqueViolationOn(p2002({ target: "DuesLateFee_obligationId_key" }), "DuesLateFee")).toBe(true);
    expect(isUniqueViolationOn(p2002({ target: "DuesLateFee_obligationId_key" }), "DuesSettlement")).toBe(false);
  });

  it("never misclassifies a genuinely unrelated error", () => {
    expect(isUniqueViolationOn(new Error("boom"), "DuesSettlement")).toBe(false);
    expect(isUniqueViolationOn(p2002({ modelName: "Student", target: ["email"] }), "DuesSettlement")).toBe(false);
    expect(isUniqueViolationOn(p2002({ modelName: "Student", target: ["email"] }), "DuesLateFee")).toBe(false);
    expect(isUniqueViolationOn(null, "DuesSettlement")).toBe(false);
  });
});
