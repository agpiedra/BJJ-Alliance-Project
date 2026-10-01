"use server";

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { generateStudentCode } from "@/lib/students/generate-code";
import { isAcademyInTenantScope, resolveActionContext } from "@/lib/tenant/context";
import { getScopedDb } from "@/lib/tenant/scoped-client";
import { Prisma, StudentStatus } from "@/generated/prisma/client";
import type { ActionState } from "@/lib/action-state";
import { todayInAsDbDate } from "@/lib/students/status-history";
import type { Tx } from "@/lib/students/lock";
import type { TenantContext } from "@/lib/tenant/types";
import { inactiveLedgerActivation, type LedgerDeps } from "@/lib/dues/ledger/activation";
import { todayIn } from "@/lib/dues/ledger/common";
import { enrollmentChargeInTx } from "@/lib/dues/ledger/enrollment-charge";
import { assignPlanInTx, resolvePlanId } from "@/lib/dues/assignment-actions";
import { EnrollmentRefusedError, type EnrollmentRefusalReason } from "@/lib/dues/enrollment-refused-error";

const createStudentSchema = z
  .object({
    firstName: z.string().min(1),
    lastName: z.string().min(1),
    phone: z.string().min(1),
    email: z.string().email(),
    homeAcademyId: z.string().min(1),
    // MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 3c-i: "add a required track
    // control... selecting the track filters the rank dropdown to that
    // track's ranks." The client already has the real BeltRank id from the
    // rankOptions it was given (the same rows the dropdown was built from),
    // so it submits that id directly rather than a belt code the server
    // re-resolves — currentRankId is still re-validated below against
    // `track` and the org's own scoped rank table, never trusted bare.
    track: z.enum(["ADULT", "KIDS"]),
    currentRankId: z.string().min(1),
    currentStripes: z.coerce.number().int().min(0),
    // Roughly when this belt was awarded - a HISTORICAL date, optional and possibly unknown. Omitted
    // means "starting today". It never blocks progress and never seeds any: academy progress
    // always starts at 0 from the moment the system begins tracking the student
    // (Student.progressBaselineAt, set by the database default), and there are no head-start
    // credits (docs/PROMOTION_PROGRESS_PROPOSAL.md).
    beltAwardedAt: z.string().optional(),
    dateOfBirth: z.string().optional(),
    guardianName: z.string().optional(),
    guardianPhone: z.string().optional(),
    emergencyContact: z.string().optional(),
    // Enrollment/resume integration plan §7.6: the monthly plan to assign at enrollment, billing-active only.
    // Empty/omitted means "no plan supplied" (§7.5's configuration-gap path decides what happens next), never a
    // default or an inferred plan.
    planId: z.string().optional(),
    // §7.7: a client-generated, stable identity for ONE logical submission attempt (see create-student-form.tsx for
    // its exact lifetime). Empty/omitted disables the idempotency mechanism for that one submission (a defensive
    // fallback, never the normal case) — it is never derived from any other field here.
    creationRequestId: z.string().optional(),
  })
  .refine(
    (data) => {
      if (!data.dateOfBirth) return true;
      const age = (Date.now() - new Date(data.dateOfBirth).getTime()) / (365.25 * 24 * 60 * 60 * 1000);
      if (age < 18) return !!data.guardianName && !!data.guardianPhone;
      return true;
    },
    { message: "guardianRequiredForMinor", path: ["guardianName"] },
  );

type CreateStudentData = z.infer<typeof createStudentSchema>;

export type CreateStudentState = ActionState & { code?: string; alreadyCreated?: boolean };

/**
 * §7.7: the canonical, validated creation inputs — every meaningful submitted field (including the selected plan
 * id, if any), EXCLUDING every server-generated value (codeHash, the generated id, createdAt). Computed from
 * `createStudentSchema`'s own already-validated, already-normalized output, never a second, parallel normalization
 * pass. Stored verbatim as `Student.creationFingerprint`; a retry's resubmitted inputs are compared against this
 * STORED snapshot (via `fingerprintsEqual` below), never against the student's current, possibly-since-edited row.
 */
function buildCreationFingerprint(data: CreateStudentData, planId: string | null): Record<string, unknown> {
  return {
    firstName: data.firstName,
    lastName: data.lastName,
    phone: data.phone,
    email: data.email,
    homeAcademyId: data.homeAcademyId,
    track: data.track,
    currentRankId: data.currentRankId,
    currentStripes: data.currentStripes,
    beltAwardedAt: data.beltAwardedAt ?? null,
    dateOfBirth: data.dateOfBirth ?? null,
    guardianName: data.guardianName ?? null,
    guardianPhone: data.guardianPhone ?? null,
    emergencyContact: data.emergencyContact ?? null,
    planId,
  };
}

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
 * Enrollment/resume integration plan §7.6-§7.7: the gated financial + idempotency half of `createStudent` (below),
 * extracted into this `deps`-injectable core so `createStudent`'s own exported signature never needs an activation
 * or date override — the identical composition boundary `resumeChargeInTx`/`approveStudentInTx` already established
 * elsewhere in this ledger. `createStudent` calls this with the default production `deps` ({}); only a test,
 * importing `createStudentInTx` (or `createStudentCore` below) directly, ever exercises the branch below
 * `isActive`.
 *
 * `creationRequestId`/`creationFingerprint` are set on the created row ONLY when billing is active (§7.7, scoped —
 * never a change to the inactive path, which stays byte-identical to today). The ADMIN-only check for a supplied
 * `planId` lives here, not in `createStudent`, because the required test proving a DIRECTOR's attempt refuses with
 * zero writes can only exercise this under injected, active `deps` — there is no other seam to reach it through.
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
 * `LedgerActivation` implementation), matching this file's own activation gate exactly; kept as its own named
 * export (rather than inlining `inactiveLedgerActivation.isActive` into the page, which would make the page itself
 * an importer of `src/lib/dues/ledger/`, outside this guard's authorized-caller list).
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

/**
 * Staff-side manual creation (spec §4.6: "Staff can also create students
 * manually from the dashboard and hand over the generated code"). Unlike
 * public signup, this never creates a `User` row — staff-created students
 * get only the generated check-in code, no portal password yet, matching
 * `Student.userId` being nullable for exactly this case.
 *
 * Enrollment/resume integration plan §7.5-§7.7: when billing is active, this now also resolves/creates the
 * student's monthly-plan assignment and the resulting SIGNUP(+MONTHLY) charge atomically with the creation itself,
 * and protects the creation against a double-click or a lost-response retry via `creationRequestId`. This
 * function's own exported signature is unchanged by any of that — no activation dependency, no date override.
 */
export async function createStudent(
  organizationId: string,
  _prevState: CreateStudentState,
  formData: FormData,
): Promise<CreateStudentState> {
  const auth = await resolveActionContext(organizationId, ["ADMIN", "DIRECTOR"]);
  if (!auth.ok) return { error: "forbiddenAcademy", fieldErrors: { homeAcademyId: ["forbiddenAcademy"] } };
  const context = auth.context;

  const raw = Object.fromEntries(formData.entries());
  const parsed = createStudentSchema.safeParse(raw);

  if (!parsed.success) {
    return { error: "invalid", fieldErrors: parsed.error.flatten().fieldErrors };
  }

  const data = parsed.data;

  const academy = await getScopedDb(context).academy.findUnique({
    where: { id: data.homeAcademyId },
    select: { organizationId: true, timezone: true },
  });
  // Never trust a client-submitted academy id, even from an authenticated
  // DIRECTOR — a DIRECTOR assigned only to Escalante must not be able to
  // create a student at Escazú just because the form field said so (e.g.
  // devtools tampering with a hidden field for a single-academy director).
  // The UI only ever offers in-scope academies as options; this check is
  // the actual, server-side gate. `getScopedDb` returns `null` outright for
  // an academy in another organization (structural, not a manual compare);
  // `isAcademyInTenantScope` only checks branch-level scope on top of that
  // and returns true unconditionally for ADMIN's "ALL", which says nothing
  // about which organization the academy belongs to.
  if (!academy || !isAcademyInTenantScope(context, data.homeAcademyId)) {
    return { error: "forbiddenAcademy", fieldErrors: { homeAcademyId: ["forbiddenAcademy"] } };
  }

  const { code, codeHash } = await generateStudentCode(academy.organizationId);

  // Re-validate the submitted rank against the submitted track and this
  // org's own scoped catalog — never trust a client-submitted id bare, even
  // though the UI only ever offers ids it fetched itself (the same
  // reasoning as homeAcademyId above). A plain scoped read, not part of the
  // write transaction below (which stays on the raw client because it must
  // combine a tenant-scoped write with an AuditLog row atomically, and
  // AuditLog is deliberately outside getScopedDb's reach; see that
  // wrapper's own module doc comment for why).
  const rank = await getScopedDb(context).beltRank.findFirst({
    where: { id: data.currentRankId, track: data.track },
    select: { id: true, code: true, maxStripes: true },
  });
  if (!rank) {
    return { error: "invalid", fieldErrors: { currentRankId: ["invalid"] } };
  }
  if (data.currentStripes > rank.maxStripes) {
    return { error: "invalid", fieldErrors: { currentStripes: ["invalid"] } };
  }

  // The historical belt date exactly as staff typed it (or now when omitted). Progress does not read it.
  const beltAwardedAt = data.beltAwardedAt ? new Date(data.beltAwardedAt) : new Date();

  // Enrollment/resume integration plan §7.6: `resolvePlanId` reuses `assignPlan`'s own exact validation (exists,
  // in-org, this student's branch, not a package) — never a second, drifting copy. Empty/omitted means "no plan
  // supplied", which the gated core correctly refuses as a configuration gap when billing is active (§7.5) — not a
  // special case here.
  const planIdRaw = data.planId && data.planId.length > 0 ? data.planId : null;
  const plan = planIdRaw ? await resolvePlanId(academy.organizationId, data.homeAcademyId, planIdRaw) : { ok: true as const, value: null };
  if (!plan.ok) {
    return { error: "invalid", fieldErrors: { planId: ["invalid"] } };
  }

  const creationRequestId = data.creationRequestId && data.creationRequestId.length > 0 ? data.creationRequestId : null;
  const fingerprint = buildCreationFingerprint(data, plan.value);

  const result = await createStudentCore(
    { context, academy, data, rank: { id: rank.id, code: rank.code }, codeHash, beltAwardedAt, planId: plan.value, creationRequestId, fingerprint },
    {},
  );

  if (!result.ok) {
    if (result.error === "requiresAdmin") return { error: "requiresAdmin", fieldErrors: { planId: ["requiresAdmin"] } };
    return { error: result.error };
  }
  if (result.alreadyCreated) {
    return { ok: true, alreadyCreated: true };
  }
  return { ok: true, code };
}
