import { describe, expect, it } from "vitest";
import { Prisma } from "../../src/generated/prisma/client";
import { isUniqueViolationOnConstraint } from "../../src/lib/dues/ledger/unique-violation";

/**
 * Late-fee-assessment brief §6.3, corrected: a P2002 must be identified by the CONSTRAINT that fired, not the table — a table can
 * have more than one unique index (DuesLateFee has two). The shape used below is the REAL one, empirically captured by forcing a
 * genuine duplicate-key violation against this project's actual Prisma 7 + `@prisma/adapter-pg` setup (a duplicate `User.email`):
 *   { driverAdapterError: { cause: { kind: "UniqueConstraintViolation", constraint: { index: "User_email_key" }, ... } }, modelName }
 * `error.meta.target` does not exist in this project's real errors at all — this file's own fake objects match the real shape
 * deliberately, not a guessed or simplified one. The corresponding integration test
 * (tests/integration/late-fee-assessment.test.ts) additionally exercises this against a real Postgres violation, not only this
 * deterministic, constructed one.
 */
function p2002(cause: Record<string, unknown> | undefined, modelName?: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "test",
    meta: { modelName, ...(cause !== undefined ? { driverAdapterError: { name: "DriverAdapterError", cause } } : {}) },
  });
}

const realCause = (index: string, table: string) => ({ originalCode: "23505", kind: "UniqueConstraintViolation", constraint: { index }, table });

describe("isUniqueViolationOnConstraint", () => {
  it("identifies the exact constraint by its index name", () => {
    expect(isUniqueViolationOnConstraint(p2002(realCause("DuesSettlement_one_active_per_obligation_key", "DuesSettlement")), "DuesSettlement_one_active_per_obligation_key")).toBe(true);
    expect(isUniqueViolationOnConstraint(p2002(realCause("DuesLateFee_obligationId_key", "DuesLateFee")), "DuesLateFee_obligationId_key")).toBe(true);
  });

  it("does not confuse two different unique constraints on the SAME table (DuesLateFee has two)", () => {
    expect(isUniqueViolationOnConstraint(p2002(realCause("DuesLateFee_organizationId_id_obligationId_key", "DuesLateFee")), "DuesLateFee_obligationId_key")).toBe(false);
    expect(isUniqueViolationOnConstraint(p2002(realCause("DuesLateFee_obligationId_key", "DuesLateFee")), "DuesLateFee_organizationId_id_obligationId_key")).toBe(false);
  });

  it("does not match a constraint on an unrelated table just because the requested name is unrelated too", () => {
    expect(isUniqueViolationOnConstraint(p2002(realCause("User_email_key", "User")), "DuesSettlement_one_active_per_obligation_key")).toBe(false);
  });

  it("fails CLOSED for an unrecognized shape — a P2002 with no driverAdapterError metadata is never assumed to match", () => {
    expect(isUniqueViolationOnConstraint(p2002(undefined, "DuesSettlement"), "DuesSettlement_one_active_per_obligation_key")).toBe(false);
    expect(isUniqueViolationOnConstraint(p2002({ kind: "SomethingElse", constraint: { index: "DuesSettlement_one_active_per_obligation_key" } }), "DuesSettlement_one_active_per_obligation_key")).toBe(false);
  });

  it("never misclassifies a genuinely unrelated error", () => {
    expect(isUniqueViolationOnConstraint(new Error("boom"), "DuesSettlement_one_active_per_obligation_key")).toBe(false);
    expect(isUniqueViolationOnConstraint(null, "DuesSettlement_one_active_per_obligation_key")).toBe(false);
    expect(isUniqueViolationOnConstraint(undefined, "DuesSettlement_one_active_per_obligation_key")).toBe(false);
  });
});
