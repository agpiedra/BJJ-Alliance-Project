import { Prisma, StudentStatus } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { getScopedDb } from "@/lib/tenant/scoped-client";
import { todayInAsDbDate } from "@/lib/students/status-history";
import type { Tx } from "@/lib/students/lock";
import type { TenantContext } from "@/lib/tenant/types";
import { inactiveLedgerActivation, type LedgerDeps } from "@/lib/dues/ledger/activation";
import { todayIn } from "@/lib/dues/ledger/common";
import { enrollmentChargeInTx } from "@/lib/dues/ledger/enrollment-charge";
import { assignPlanInTx } from "@/lib/dues/assignment-core";
import { EnrollmentRefusedError, type EnrollmentRefusalReason } from "@/lib/dues/enrollment-refused-error";
import type { CreateStudentData } from "./create-student-action";

/**
 * Deliberately NOT a "use server" file. `createStudentInTx`/`createStudentCore`/`isEnrollmentBillingActive` take
 * plain, already-trusted arguments (a `TenantContext`, a resolved academy/rank, a generated `codeHash`) and perform
 * NO authentication/authorization/tenant-scoping of their own — they trust validation `createStudent`
 * (`./create-student-action.ts`) already did. In Next.js, every exported async function in a "use server" file
 * becomes a directly client-invocable server action with a stable reference regardless of intent — called
 * directly, a client could forge a `TenantContext`, an academy, or a codeHash and bypass `resolveActionContext`/
 * `isAcademyInTenantScope`/the rank re-validation entirely. `create-student-action.ts` imports this module and
 * exports only `createStudent` — the genuinely public, already-authenticated action.
 */

/** A deterministic string for deep-equality comparison — JSONB does not preserve key order across a round-trip through Postgres, so a raw `JSON.stringify` comparison would be unreliable; both sides are canonicalized here before comparing. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(",")}}`;
}
function fingerprintsEqual(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

/**
 * The SPECIFIC `(organizationId, creationRequestId)` unique violation — never a bare "is this some P2002", which
 * would misclassify an unrelated violation (e.g. a `codeHash` collision, a genuinely different constraint) as a
 * retry. `meta.target`'s exact shape is not trusted blind (it varies by provider/driver and was empirically found,
 * against this exact engine version, NOT to reliably be a string or array naming the constraint for this hand-written
 * index) — so this also falls back to Prisma's own formatted error message, confirmed directly against this engine
 * to read "Unique constraint failed on the constraint: `Student_organizationId_creationRequestId_key`", which names
 * the constraint unambiguously regardless of `meta`'s shape.
 */
function isCreationRequestIdViolation(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") return false;
  const target = (error.meta as { target?: unknown } | undefined)?.target;
  if (typeof target === "string" && target.includes("creationRequestId")) return true;
  if (Array.isArray(target) && target.includes("creationRequestId")) return true;
  return error.message.includes("creationRequestId");
}

/**
 * The exact shape `create-student-form.tsx` generates (`crypto.randomUUID()`): a canonical, lowercase-or-uppercase
 * RFC 4122 UUID. Validated server-side, not trusted bare — a client could submit any string in this field's place.
 */
const CREATION_REQUEST_ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for a non-blank string matching the shape the form actually generates — false for `null`, `undefined`, `""`, or anything malformed. */
function isWellFormedCreationRequestId(value: string | null | undefined): value is string {
  return typeof value === "string" && CREATION_REQUEST_ID_SHAPE.test(value);
}

/**
 * Enrollment/resume integration plan §7.6-§7.7: the gated financial + idempotency half of `createStudent`
 * (`./create-student-action.ts`), extracted into this `deps`-injectable core so `createStudent`'s own exported
 * signature never needs an activation or date override — the identical composition boundary
 * `resumeChargeInTx`/`approveStudentInTx` already established elsewhere in this ledger. `createStudent` calls this
 * with the default production `deps` ({}); only a test, importing `createStudentInTx` (or `createStudentCore`
 * below) directly, ever exercises the branch below `isActive`.
 *
 * `creationRequestId`/`creationFingerprint` are set on the created row ONLY when billing is active (§7.7, scoped —
 * never a change to the inactive path, which stays byte-identical to today). The ADMIN-only check for a supplied
 * `planId` lives here, not in `createStudent`, because the required test proving a DIRECTOR's attempt refuses with
 * zero writes can only exercise this under injected, active `deps` — there is no other seam to reach it through.
 *
 * Corrected: a missing, blank, or malformed `creationRequestId` on the active-billing path now refuses the WHOLE
 * operation (`missingSubmissionIdentity`) BEFORE any write — checked first, even before the ADMIN-only plan check,
 * since it is the more fundamental precondition. The prior draft silently proceeded with `creationRequestId: null`
 * for any submission that happened to omit or blank the field, defeating the §7.7 mechanism entirely for that
 * submission — never an approved behavior, an unstated judgment call corrected here. The inactive path is
 * completely unaffected: this check only runs when `isActive`.
 */
export async function createStudentInTx(
  tx: Tx,
  args: {
    context: TenantContext;
    academy: { organizationId: string; timezone: string };
    data: CreateStudentData;
    rank: { id: string; code: string };
    codeHash: string;
    beltAwardedAt: Date;
    planId: string | null;
    creationRequestId: string | null;
    fingerprint: Record<string, unknown>;
  },
  deps: LedgerDeps = {},
): Promise<{ studentId: string }> {
  const { context, academy, data, rank, codeHash, beltAwardedAt, planId, creationRequestId, fingerprint } = args;
  const activation = deps.activation ?? inactiveLedgerActivation;
  const isActive = await activation.isActive(academy.organizationId);
  // ONE creation instant, captured once — reused for both the status-history effectiveOn and (when active) the
  // ledger charge's own enrollment date, never a second clock read (D13: a staff-created student's E is the
  // creation date itself).
  const now = (deps.now ?? (() => new Date()))();

  // §7.7: required before ANY write whenever billing is active — checked first, before the ADMIN-only plan check
  // and before tx.student.create. Never applies to the inactive path (byte-identical to before this PR).
  if (isActive && !isWellFormedCreationRequestId(creationRequestId)) {
    throw new EnrollmentRefusedError("missingSubmissionIdentity");
  }

  // §7.6: creating a NEW assignment is ADMIN-only. A brand-new student never has an existing assignment, so a
  // supplied planId always means a new one — unlike approveStudentInTx, there is no "reuse the existing one"
  // case to distinguish first. Checked BEFORE any write, so a DIRECTOR's refused attempt leaves zero rows.
  if (isActive && planId && context.organizationRole !== "ADMIN") {
    throw new EnrollmentRefusedError("requiresAdmin");
  }

  // Staff created this student directly (in person or over the phone) —
  // there's no self-signup review step to wait on, so this row starts
  // ACTIVE rather than the PENDING that public /signup uses.
  const student = await tx.student.create({
    data: {
      homeAcademyId: data.homeAcademyId,
      organizationId: academy.organizationId,
      track: data.track,
      firstName: data.firstName,
      lastName: data.lastName,
      phone: data.phone,
      email: data.email,
      currentRankId: rank.id,
      currentStripes: data.currentStripes,
      beltAwardedAt,
      dateOfBirth: data.dateOfBirth ? new Date(data.dateOfBirth) : undefined,
      guardianName: data.guardianName,
      guardianPhone: data.guardianPhone,
      emergencyContact: data.emergencyContact,
      codeHash,
      status: StudentStatus.ACTIVE,
      userId: null,
      creationRequestId: isActive ? creationRequestId : null,
      creationFingerprint: isActive && creationRequestId ? (fingerprint as Prisma.InputJsonValue) : Prisma.DbNull,
    },
  });

  // Eligibility-prerequisites brief, 3.2: the first `StudentStatusChange` row. No lock is needed — a row that does not yet exist
  // cannot be locked, and nothing else can reference this student's freshly-generated id until this transaction commits.
  await tx.studentStatusChange.create({
    data: {
      organizationId: student.organizationId,
      studentId: student.id,
      status: StudentStatus.ACTIVE,
      effectiveOn: todayInAsDbDate(academy.timezone, now),
      sequence: 1,
      source: "EVENT",
      actorId: context.actorUserId,
    },
  });

  await tx.auditLog.create({
    data: {
      actorId: context.actorUserId,
      organizationId: context.organizationId,
      academyId: student.homeAcademyId,
      action: "student.create",
      entityType: "Student",
      entityId: student.id,
      // SQL NULL, not the JSON literal `null` — Prisma rejects a bare JS
      // `null` for a nullable Json column.
      before: Prisma.DbNull,
      // Non-sensitive fields only. `codeHash` is deliberately excluded —
      // it is the student's check-in secret in its only stored form, and
      // copying it into an append-only audit table would create a second
      // place it could leak from (see the note on `regenerateStudentCode`).
      after: {
        firstName: student.firstName,
        lastName: student.lastName,
        homeAcademyId: student.homeAcademyId,
        track: student.track,
        currentBelt: rank.code,
        currentStripes: student.currentStripes,
        status: student.status,
      },
    },
  });

  // Enrollment/resume integration plan §7.5-§7.6: when billing is active, resolve/create the assignment and the
  // resulting SIGNUP(+MONTHLY) charge, atomically with the creation above. D13: for a staff-created student, E is
  // the creation date itself — the ONE instant captured just above for StudentStatusChange, reused here, never a
  // second clock read.
  if (isActive) {
    const enrollmentDate = todayIn(academy.timezone, now);
    if (planId) {
      const assigned = await assignPlanInTx(tx, {
        context,
        studentId: student.id,
        homeAcademyId: student.homeAcademyId,
        timezone: academy.timezone,
        planId,
        effectiveYear: enrollmentDate.year,
        effectiveMonth: enrollmentDate.month,
      });
      // pastMonth is structurally unreachable here (enrollmentDate is THIS transaction's own "now") — treated as a
      // genuine refusal if it ever occurs, never silently ignored.
      if (!assigned.ok) throw new EnrollmentRefusedError("inapplicable");
    }
    const charge = await enrollmentChargeInTx(tx, { context, student: { id: student.id, homeAcademyId: student.homeAcademyId }, enrollmentDate, assignedPlanId: planId }, deps);
    if (!charge.ok) {
      if (charge.error === "notActive" || charge.error === "notFound") throw new EnrollmentRefusedError("inapplicable");
      throw new EnrollmentRefusedError(charge.error);
    }
  }

  return { studentId: student.id };
}

/**
 * Enrollment/resume integration plan §7.6: the server-side read `students/page.tsx` uses to decide whether to
 * render the plan-selector at all — never from request data. Trivially always `false` today (the only production
 * `LedgerActivation` implementation), matching this file's own activation gate exactly.
 */
export async function isEnrollmentBillingActive(organizationId: string): Promise<boolean> {
  return inactiveLedgerActivation.isActive(organizationId);
}

export type CreateStudentCoreResult =
  | { ok: true; studentId: string; alreadyCreated: boolean }
  | { ok: false; error: EnrollmentRefusalReason | "conflictingResubmission" };

/**
 * Wraps `createStudentInTx`'s `$transaction` AND the §7.7 recovery that must happen strictly OUTSIDE it (a Postgres
 * unique-constraint violation aborts the whole transaction — no further statement on that `tx` succeeds, so the
 * recovery lookup below is a fresh, separate query, never a re-query on the aborted `tx`). This is the reason the
 * `deps`-injectable seam sits one level higher here than `resumeChargeInTx`'s own "transaction body only" shape:
 * idempotency recovery cannot live inside a `*InTx` function by definition, since it only runs once that
 * transaction has already ended. `createStudent`'s own exported signature is still unchanged by this — it calls
 * this function with the default production `deps` ({}), exactly like every other gated action in this ledger.
 */
export async function createStudentCore(
  args: {
    context: TenantContext;
    academy: { organizationId: string; timezone: string };
    data: CreateStudentData;
    rank: { id: string; code: string };
    codeHash: string;
    beltAwardedAt: Date;
    planId: string | null;
    creationRequestId: string | null;
    fingerprint: Record<string, unknown>;
  },
  deps: LedgerDeps = {},
): Promise<CreateStudentCoreResult> {
  try {
    const { studentId } = await prisma.$transaction((tx) => createStudentInTx(tx, args, deps));
    return { ok: true, studentId, alreadyCreated: false };
  } catch (error) {
    if (error instanceof EnrollmentRefusedError) return { ok: false, error: error.reason };
    if (args.creationRequestId && isCreationRequestIdViolation(error)) {
      // Recovered OUTSIDE the aborted transaction, via a fresh, authorized, organization-scoped lookup — never the
      // transaction above, which Postgres has already rolled back by the time this catch runs.
      const existing = await getScopedDb(args.context).student.findFirst({
        where: { creationRequestId: args.creationRequestId },
        select: { id: true, creationFingerprint: true },
      });
      // The row this violation names must exist by now (the constraint only fires against a committed row) — if it
      // genuinely doesn't (a structural impossibility, not a race), this is not our case to handle: rethrow.
      if (!existing) throw error;
      if (!fingerprintsEqual(existing.creationFingerprint, args.fingerprint)) {
        return { ok: false, error: "conflictingResubmission" };
      }
      return { ok: true, studentId: existing.id, alreadyCreated: true };
    }
    throw error; // every unrelated database error propagates unchanged
  }
}
