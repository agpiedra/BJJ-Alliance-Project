"use server";

import { z } from "zod";
import { generateStudentCode } from "@/lib/students/generate-code";
import { isAcademyInTenantScope, resolveActionContext } from "@/lib/tenant/context";
import { getScopedDb } from "@/lib/tenant/scoped-client";
import type { ActionState } from "@/lib/action-state";
import { resolvePlanId } from "@/lib/dues/assignment-core";
import { createStudentCore } from "./create-student-core";

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
    // its exact lifetime). Required, well-formed, and non-blank on the active-billing path (createStudentInTx
    // refuses the whole operation otherwise, §7.7 corrected) — empty/omitted/malformed is only ever harmless on the
    // inactive path, where it is never persisted at all.
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

export type CreateStudentData = z.infer<typeof createStudentSchema>;

export type CreateStudentState = ActionState & { code?: string; alreadyCreated?: boolean };

/**
 * §7.7: the canonical, validated creation inputs — every meaningful submitted field (including the selected plan
 * id, if any), EXCLUDING every server-generated value (codeHash, the generated id, createdAt). Computed from
 * `createStudentSchema`'s own already-validated, already-normalized output, never a second, parallel normalization
 * pass. Stored verbatim as `Student.creationFingerprint`; a retry's resubmitted inputs are compared against this
 * STORED snapshot (`createStudentCore`'s own `fingerprintsEqual`), never against the student's current,
 * possibly-since-edited row.
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
 * function's own exported signature is unchanged by any of that — no activation dependency, no date override. The
 * gated/idempotency logic itself lives in `./create-student-core` (a plain, non-"use server" module) — see that
 * file's own doc comment for why it cannot live here.
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

  // §7.7: normalized here (blank -> null), but the REQUIREDNESS check (well-formed, non-null, whenever billing is
  // active) lives in createStudentInTx — this function has no way to know activation state before calling it.
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
