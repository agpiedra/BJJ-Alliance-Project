# Phase 4: Progression Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the belt-progression eligibility engine (pure, unit-tested first per spec §10), a
staff-facing promotion queue with a manual confirm action, and a permanent promotion history
display — the last piece needed before a student's belt/stripe count can ever actually change in
this app.

**Architecture:** Extract the belt-progress math already living inside Phase 3's
`getAtBeltSummary` into standalone pure functions, unit-test them exhaustively (spec's own test
list), then layer a batch query (who's eligible/approaching, scoped by academy) and a
transactional confirm action (writes `Promotion`, mutates `Student.currentBelt/currentStripes`,
audits) on top. No new tables — `Promotion` and `BeltRequirement` were both seeded in Phase 1.

**Tech Stack:** Next.js 15 App Router, Prisma 7 (`prisma-client` generator + `PrismaPg` adapter),
Zod, Vitest, Luxon (no new date math needed here — Phase 3 already owns it), next-intl.

**Spec:** `PROJECT_SPEC.md` (repo root) — §2.1 (belt/stripe thresholds), §2.3 (promotions are
never automatic), §3 (roles — DIRECTOR/ADMIN confirm, INSTRUCTOR views only), §4.3 (dashboard
promotion queue + approaching), §4.5 (promotion history on student detail), §9 (Phase 4 scope:
"eligibility engine, promotion queue, promotion confirmation, history"), §10 (quality bar: "the
eligibility engine is the heart of the app — write unit tests for it first", exact test-case
list, "all money and belt-affecting mutations are audited").

## Global Constraints

- **Belt order**: `WHITE → BLUE → PURPLE → BROWN → BLACK` (`prisma/schema.prisma`'s `Belt` enum).
  BLACK is terminal — `BeltRequirement` seeds it with `attendancesPerStripe: 0, maxStripes: 0,
  attendancesForExam: 0`, and Phase 3's existing math already correctly yields no eligibility
  signal at all for a BLACK-belt student (`atMaxStripes` is trivially true, `attendancesForExam >
  0` is false, so both branches in `getAtBeltSummary` are skipped). Do not special-case BLACK
  anywhere new — the existing math already handles it; a `nextBelt()` helper should simply never
  be called for it, since nothing will ever mark a BLACK-belt student eligible.
- **Ruling (carried from Phase 3's frozen formula, made explicit here): the "at-belt" baseline
  (`Student.beltAwardedAt`) resets ONLY on a belt-level promotion, never on a stripe-within-belt
  award.** Spec §2.3 says confirming "resets the at-belt attendance baseline" — read narrowly,
  this describes what happens when the belt itself changes. Phase 2/3's shipped, reviewed formula
  (`attendancesIntoCurrentStripeSpan = atBeltCount - currentStripes * attendancesPerStripe`, and
  `atBeltCount` itself = sum of records since `beltAwardedAt`) only produces correct stripe math
  if `atBeltCount` accumulates continuously across all of a belt's stripes — it would be wrong if
  the baseline reset at every stripe. A stripe award therefore only increments
  `Student.currentStripes`; a belt award additionally resets `Student.beltAwardedAt` to `now()`
  and sets `currentStripes` to `0`. Cost if this reading is wrong: the dashboard/kiosk would show
  a student's "attendances since last event" starting from the wrong point after a stripe award —
  visibly wrong within days, trivial to spot and fix; the alternative (resetting on every stripe)
  would silently break Phase 3's already-shipped, already-tested formula.
- **Never trust a stale queue read at confirm time.** The promotion queue is a snapshot computed
  at page-render time; a negative adjustment or another confirm could change a student's
  eligibility before the "Confirmar promoción" click lands. `confirmPromotion` must re-fetch the
  student and recompute eligibility fresh, server-side, using the exact same pure functions the
  queue used to decide to show the button — and reject with a clear error if the student is no
  longer eligible, never silently promote based on stale numbers. This is the same "never trust a
  client-submitted anything for a server decision" discipline as Phase 3's
  never-trust-a-client-submitted-appointment-time rule, applied to eligibility instead of time.
- **Scope by id AND owner, same house rule as every prior phase.** `confirmPromotion` re-fetches
  the target student and re-checks `isAcademyInScope(session, student.homeAcademyId)` against the
  *freshly read* value — never a hidden form field. `requireStaffSession(["ADMIN", "DIRECTOR"])`
  — INSTRUCTOR is explicitly excluded from confirming (spec §3: INSTRUCTOR "view eligibility. No
  payments, no promotions"), unlike Phase 3's attendance-adjustment action which deliberately
  widened to include INSTRUCTOR. Do not copy that widening here.
- **Audit every promotion.** `Promotion.create` and the `Student` update happen in one
  `prisma.$transaction`, alongside an `AuditLog` row (`action: "student.promote"`, `entityType:
  "Student"`, `entityId: student.id`, `before: {belt, stripes}`, `after: {belt, stripes}`) — same
  transaction-wrapped-audit pattern as every write action since Phase 2's `updateStudent`.
- **No hard deletes; promotion history is permanent and append-only** — this phase never updates
  or deletes a `Promotion` row once written, only ever inserts.
- **Feature-branch-only.** Push to `feat/phase-4-progression`, never `main`. One PR opens at the
  end for the user to merge themselves.
- **The pnpm environment anomaly** (stray `"0"`/`"true"` keys injected into `package.json`/
  `pnpm-lock.yaml`/`pnpm-workspace.yaml` on this machine) is unrelated to this work — revert just
  those lines if `git status`/`git diff` shows them before committing.
- **Targeted git-add pathspec** for every commit: `git add -A -- ':!.agents' ':!.windsurf'
  ':!skills-lock.json'` (these three are untracked, pre-existing, and not this project's files).

---

### Task 1: Extract the pure eligibility engine + unit tests

**Files:**
- Create: `src/lib/students/eligibility.ts`, `tests/unit/eligibility.test.ts`
- Modify: `src/lib/students/attendance-summary.ts` (refactor to call the new pure function; no
  behavior change)

**Interfaces:**
- Consumes: nothing new — the shapes below are extracted from `getAtBeltSummary`'s existing
  inline math (`src/lib/students/attendance-summary.ts:69-86`).
- Produces:
  - `interface BeltRequirementLike { attendancesPerStripe: number; maxStripes: number;
    attendancesForExam: number }`
  - `interface BeltProgress { nextStripeAt: number | null; remainingToNextStripe: number | null;
    examEligible: boolean }`
  - `function computeBeltProgress(atBeltCount: number, currentStripes: number, requirement:
    BeltRequirementLike): BeltProgress`
  - `type EligibilityStatus = "stripe-eligible" | "exam-eligible" | "approaching" | "none"`
  - `function classifyEligibility(progress: BeltProgress, currentStripes: number, requirement:
    BeltRequirementLike, approachingThreshold?: number): EligibilityStatus` — `approachingThreshold`
    defaults to `5` (spec §4.3: "within 5 attendances of a threshold").
  - `const BELT_ORDER: readonly Belt[]` (import `Belt` from `@/generated/prisma/client`) —
    `["WHITE", "BLUE", "PURPLE", "BROWN", "BLACK"]`
  - `function nextBelt(belt: Belt): Belt | null` — returns the next belt in `BELT_ORDER`, or
    `null` if `belt` is already `"BLACK"` or not found (defensive; should never happen given
    `classifyEligibility` never returns `"exam-eligible"` for BLACK, per this plan's Global
    Constraints).
  - `interface PromotionTarget { fromBelt: Belt; fromStripes: number; toBelt: Belt; toStripes:
    number; kind: "stripe" | "belt" }`
  - `function resolvePromotionTarget(status: EligibilityStatus, currentBelt: Belt, currentStripes:
    number): PromotionTarget | null` — `null` if `status` is `"approaching"` or `"none"` (not
    actually eligible to confirm yet). For `"stripe-eligible"`: `{fromBelt: currentBelt,
    fromStripes: currentStripes, toBelt: currentBelt, toStripes: currentStripes + 1, kind:
    "stripe"}`. For `"exam-eligible"`: `{fromBelt: currentBelt, fromStripes: currentStripes,
    toBelt: nextBelt(currentBelt)!, toStripes: 0, kind: "belt"}` (if `nextBelt` somehow returns
    `null` here, that's a genuine invariant violation — throw, don't silently return a bad
    target).

- [ ] **Step 1: Write the failing unit tests first (spec §10's explicit mandate)**

Create `tests/unit/eligibility.test.ts`. Use White belt's real seeded requirement
(`attendancesPerStripe: 30, maxStripes: 4, attendancesForExam: 30`) as the primary fixture so the
numbers are traceable to `prisma/seed.ts`, plus one Black-belt case.

```ts
import { describe, expect, it } from "vitest";
import {
  computeBeltProgress,
  classifyEligibility,
  resolvePromotionTarget,
  nextBelt,
  BELT_ORDER,
} from "@/lib/students/eligibility";

const WHITE_REQ = { attendancesPerStripe: 30, maxStripes: 4, attendancesForExam: 30 };
const BLACK_REQ = { attendancesPerStripe: 0, maxStripes: 0, attendancesForExam: 0 };

describe("computeBeltProgress", () => {
  it("one attendance below the first stripe threshold", () => {
    const p = computeBeltProgress(29, 0, WHITE_REQ);
    expect(p.remainingToNextStripe).toBe(1);
    expect(p.examEligible).toBe(false);
  });

  it("exact threshold for the first stripe", () => {
    const p = computeBeltProgress(30, 0, WHITE_REQ);
    expect(p.remainingToNextStripe).toBe(0);
    expect(p.examEligible).toBe(false);
  });

  it("one attendance above the first stripe threshold", () => {
    const p = computeBeltProgress(31, 0, WHITE_REQ);
    expect(p.remainingToNextStripe).toBe(0);
  });

  it("4th stripe boundary: exact threshold for the 4th stripe", () => {
    const p = computeBeltProgress(120, 3, WHITE_REQ);
    expect(p.remainingToNextStripe).toBe(0);
    expect(p.examEligible).toBe(false);
  });

  it("at max stripes, one attendance below the exam threshold", () => {
    const p = computeBeltProgress(149, 4, WHITE_REQ);
    expect(p.examEligible).toBe(false);
    expect(p.remainingToNextStripe).toBe(1);
  });

  it("at max stripes, exact exam threshold", () => {
    const p = computeBeltProgress(150, 4, WHITE_REQ);
    expect(p.examEligible).toBe(true);
    expect(p.remainingToNextStripe).toBeNull();
  });

  it("at max stripes, above the exam threshold", () => {
    const p = computeBeltProgress(160, 4, WHITE_REQ);
    expect(p.examEligible).toBe(true);
  });

  it("Black belt: terminal, no stripe/exam signal ever, regardless of count", () => {
    const p = computeBeltProgress(99999, 0, BLACK_REQ);
    expect(p.remainingToNextStripe).toBeNull();
    expect(p.examEligible).toBe(false);
    expect(p.nextStripeAt).toBeNull();
  });
});

describe("classifyEligibility", () => {
  it("returns stripe-eligible exactly at a stripe threshold", () => {
    const progress = computeBeltProgress(30, 0, WHITE_REQ);
    expect(classifyEligibility(progress, 0, WHITE_REQ)).toBe("stripe-eligible");
  });

  it("returns exam-eligible exactly at the exam threshold", () => {
    const progress = computeBeltProgress(150, 4, WHITE_REQ);
    expect(classifyEligibility(progress, 4, WHITE_REQ)).toBe("exam-eligible");
  });

  it("returns approaching within the default 5-attendance window, not eligible", () => {
    const progress = computeBeltProgress(26, 0, WHITE_REQ); // 4 remaining
    expect(classifyEligibility(progress, 0, WHITE_REQ)).toBe("approaching");
  });

  it("returns none when far from any threshold", () => {
    const progress = computeBeltProgress(10, 0, WHITE_REQ); // 20 remaining
    expect(classifyEligibility(progress, 0, WHITE_REQ)).toBe("none");
  });

  it("a negative adjustment dropping a student back below an already-crossed threshold reverts to none/approaching", () => {
    // Student was at 30 (stripe-eligible); a -3 adjustment drops atBeltCount to 27.
    const progress = computeBeltProgress(27, 0, WHITE_REQ); // 3 remaining
    expect(classifyEligibility(progress, 0, WHITE_REQ)).toBe("approaching");
  });

  it("Black belt never classifies as eligible or approaching, however high the count", () => {
    const progress = computeBeltProgress(99999, 0, BLACK_REQ);
    expect(classifyEligibility(progress, 0, BLACK_REQ)).toBe("none");
  });
});

describe("nextBelt / BELT_ORDER", () => {
  it("advances through the real order", () => {
    expect(nextBelt("WHITE")).toBe("BLUE");
    expect(nextBelt("BROWN")).toBe("BLACK");
  });

  it("Black has no next belt", () => {
    expect(nextBelt("BLACK")).toBeNull();
  });

  it("BELT_ORDER matches the spec's exact sequence", () => {
    expect(BELT_ORDER).toEqual(["WHITE", "BLUE", "PURPLE", "BROWN", "BLACK"]);
  });
});

describe("resolvePromotionTarget", () => {
  it("stripe-eligible resolves to a same-belt stripe increment", () => {
    const target = resolvePromotionTarget("stripe-eligible", "WHITE", 1);
    expect(target).toEqual({ fromBelt: "WHITE", fromStripes: 1, toBelt: "WHITE", toStripes: 2, kind: "stripe" });
  });

  it("exam-eligible resolves to the next belt at 0 stripes", () => {
    const target = resolvePromotionTarget("exam-eligible", "WHITE", 4);
    expect(target).toEqual({ fromBelt: "WHITE", fromStripes: 4, toBelt: "BLUE", toStripes: 0, kind: "belt" });
  });

  it("approaching resolves to null — not actually confirmable yet", () => {
    expect(resolvePromotionTarget("approaching", "WHITE", 0)).toBeNull();
  });

  it("none resolves to null", () => {
    expect(resolvePromotionTarget("none", "WHITE", 0)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail (the module doesn't exist yet)**

Run: `pnpm test:unit tests/unit/eligibility.test.ts`
Expected: FAIL — `Cannot find module '@/lib/students/eligibility'`

- [ ] **Step 3: Implement `src/lib/students/eligibility.ts`**

Extract `computeBeltProgress` directly from `attendance-summary.ts:69-86`'s existing inline logic
(the `atMaxStripes`/`attendancesIntoCurrentStripeSpan`/`nextStripeAt`/`remainingToNextStripe`/
`examEligible` computation) — this must be a byte-for-byte-equivalent extraction, not a rewrite,
since Phase 3's already-reviewed integration tests depend on these exact semantics. Then add
`classifyEligibility`, `BELT_ORDER`, `nextBelt`, and `resolvePromotionTarget` per the signatures
above. `classifyEligibility`'s logic: if `!atMaxStripes` (derive this the same way
`computeBeltProgress` does, from `currentStripes >= requirement.maxStripes`) and
`progress.remainingToNextStripe === 0`, return `"stripe-eligible"`; if `progress.examEligible`,
return `"exam-eligible"`; if `progress.remainingToNextStripe !== null && progress.remainingToNextStripe > 0 && progress.remainingToNextStripe <= approachingThreshold`,
return `"approaching"`; otherwise `"none"`.

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `pnpm test:unit tests/unit/eligibility.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Refactor `getAtBeltSummary` to call `computeBeltProgress` instead of inlining the math**

Replace `attendance-summary.ts:69-86`'s inline block with a call to `computeBeltProgress(atBeltCount, student.currentStripes, requirement)`, spreading its three fields into the returned `AtBeltSummary`. This must be a pure extraction with zero behavior change — verify by running Phase 3's existing integration test for this file (`tests/integration/attendance-summary.test.ts`) unmodified and confirming it still passes byte-for-byte.

Run: `pnpm test:integration tests/integration/attendance-summary.test.ts`
Expected: PASS, unchanged from before this refactor.

- [ ] **Step 6: Commit**

```bash
git add tests/unit/eligibility.test.ts src/lib/students/eligibility.ts src/lib/students/attendance-summary.ts
git commit -m "feat: extract pure belt-eligibility engine with exhaustive unit tests"
git push origin feat/phase-4-progression
```

---

### Task 2: Promotion queue queries (scoped, batch)

**Files:**
- Create: `src/lib/students/promotion-queue.ts`, `tests/integration/promotion-queue.test.ts`

**Interfaces:**
- Consumes: `getAtBeltSummary` (Phase 3), `classifyEligibility` (Task 1), `academyScopeWhere`
  (`@/lib/auth/session`, Phase 2).
- Produces:
  - `interface PromotionCandidate { studentId: string; firstName: string; lastName: string;
    homeAcademyId: string; homeAcademyName: string; currentBelt: Belt; currentStripes: number;
    status: "stripe-eligible" | "exam-eligible" | "approaching"; atBeltCount: number;
    remainingToNextStripe: number | null }`
  - `function listPromotionQueue(session: StaffSession): Promise<PromotionCandidate[]>` —
    students whose status is `"stripe-eligible"` or `"exam-eligible"`, scoped to the session's
    academies (ADMIN sees both).
  - `function listApproachingStudents(session: StaffSession): Promise<PromotionCandidate[]>` —
    students whose status is `"approaching"`, same scoping.

- [ ] **Step 1: Write the failing integration test**

Create `tests/integration/promotion-queue.test.ts`. Follow this codebase's established pattern
(`withRls`/`asService` from `tests/integration/helpers/db.ts`, seeding throwaway `Student` rows
with synthetic `AttendanceRecord`s the same way `tests/integration/attendance-summary.test.ts`
does — `classSessionId: null` rows are the simplest way to set up an exact `atBeltCount` without
fighting the real class schedule, matching Task 5/8's precedent from Phase 3). Cover:
- A student exactly at a stripe threshold appears in `listPromotionQueue` with
  `status: "stripe-eligible"`.
- A student exactly at the exam threshold (4 stripes, `attendancesForExam` more) appears with
  `status: "exam-eligible"`.
- A student 3 attendances from a threshold appears ONLY in `listApproachingStudents`, not the
  queue.
- A student 20 attendances from any threshold appears in neither list.
- A DIRECTOR/INSTRUCTOR session (scoped to Escazú only) never sees an Escalante-only eligible
  student in either list; an ADMIN session sees both academies' eligible students.
- A Black-belt student at any attendance count appears in neither list.

- [ ] **Step 2: Run to confirm it fails**

Run: `pnpm test:integration tests/integration/promotion-queue.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement `src/lib/students/promotion-queue.ts`**

```ts
import { prisma } from "@/lib/prisma";
import { academyScopeWhere, type StaffSession } from "@/lib/auth/session";
import { getAtBeltSummary } from "@/lib/students/attendance-summary";
import { classifyEligibility, type EligibilityStatus } from "@/lib/students/eligibility";
import type { Belt } from "@/generated/prisma/client";

export interface PromotionCandidate {
  studentId: string;
  firstName: string;
  lastName: string;
  homeAcademyId: string;
  homeAcademyName: string;
  currentBelt: Belt;
  currentStripes: number;
  status: "stripe-eligible" | "exam-eligible" | "approaching";
  atBeltCount: number;
  remainingToNextStripe: number | null;
}

async function resolveBeltRequirementLike(belt: Belt, homeAcademyId: string) {
  const perAcademy = await prisma.beltRequirement.findUnique({
    where: { academyId_belt: { academyId: homeAcademyId, belt } },
  });
  if (perAcademy) return perAcademy;
  return prisma.beltRequirement.findFirstOrThrow({ where: { academyId: null, belt } });
}

async function classifyActiveStudents(session: StaffSession): Promise<
  Array<{ candidate: PromotionCandidate; status: EligibilityStatus }>
> {
  const scope = academyScopeWhere(session);
  const students = await prisma.student.findMany({
    where: {
      status: "ACTIVE",
      ...(scope.academyId ? { homeAcademyId: scope.academyId } : {}),
    },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      homeAcademyId: true,
      homeAcademy: { select: { name: true } },
      currentBelt: true,
      currentStripes: true,
    },
  });

  const results = await Promise.all(
    students.map(async (student) => {
      const [summary, requirement] = await Promise.all([
        getAtBeltSummary(student.id),
        resolveBeltRequirementLike(student.currentBelt, student.homeAcademyId),
      ]);
      const status = classifyEligibility(
        { nextStripeAt: summary.nextStripeAt, remainingToNextStripe: summary.remainingToNextStripe, examEligible: summary.examEligible },
        student.currentStripes,
        requirement,
      );
      return {
        status,
        candidate: {
          studentId: student.id,
          firstName: student.firstName,
          lastName: student.lastName,
          homeAcademyId: student.homeAcademyId,
          homeAcademyName: student.homeAcademy.name,
          currentBelt: student.currentBelt,
          currentStripes: student.currentStripes,
          status: status as "stripe-eligible" | "exam-eligible" | "approaching",
          atBeltCount: summary.atBeltCount,
          remainingToNextStripe: summary.remainingToNextStripe,
        },
      };
    }),
  );

  return results;
}

export async function listPromotionQueue(session: StaffSession): Promise<PromotionCandidate[]> {
  const classified = await classifyActiveStudents(session);
  return classified
    .filter((r) => r.status === "stripe-eligible" || r.status === "exam-eligible")
    .map((r) => r.candidate);
}

export async function listApproachingStudents(session: StaffSession): Promise<PromotionCandidate[]> {
  const classified = await classifyActiveStudents(session);
  return classified.filter((r) => r.status === "approaching").map((r) => r.candidate);
}
```

(`classifyActiveStudents` is intentionally not exported — it exists only to avoid running the
per-student summary/requirement lookups twice when a caller wants both lists. If a future caller
needs both, it can call both exported functions; the double work is small at this app's scale and
not worth a combined-return API surface yet.)

- [ ] **Step 4: Run to confirm it passes**

Run: `pnpm test:integration tests/integration/promotion-queue.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/students/promotion-queue.ts tests/integration/promotion-queue.test.ts
git commit -m "feat: add scoped promotion-queue and approaching-students queries"
git push origin feat/phase-4-progression
```

---

### Task 3: Promotion confirmation action

**Files:**
- Create: `src/app/[locale]/dashboard/promotion-actions.ts`, `tests/integration/promotion-actions.test.ts`

**Interfaces:**
- Consumes: `resolvePromotionTarget`, `classifyEligibility`, `computeBeltProgress` (Task 1),
  `getAtBeltSummary` (Phase 3), `requireStaffSession`/`isAcademyInScope` (Phase 2), `ActionState`
  (`@/app/dashboard/_components/form` or wherever this codebase's shared `ActionState` type
  actually lives — check `src/app/[locale]/students/[id]/actions.ts`'s import for the real path).
- Produces: `confirmPromotion(_prevState: ActionState, formData: FormData): Promise<ActionState>`
  — `"use server"`.

- [ ] **Step 1: Write the failing integration test**

Create `tests/integration/promotion-actions.test.ts`, following `students/[id]/actions.ts`'s
established test pattern (raw-SQL-replay via `withRls`, or importing the exported action function
directly if this file's dependency shape allows it the way Phase 3's public-route tests did —
check which pattern Phase 2's `updateStudent`/`archiveStudent` tests use, since this action is
cookie-bound the same way, and match that). Cover:
- A student exactly at a stripe threshold: confirming increments `currentStripes` by 1, leaves
  `currentBelt` and `beltAwardedAt` unchanged, writes a `Promotion` row with `kind`-equivalent
  data (`fromStripes` = old value, `toStripes` = old + 1, same belt), and an `AuditLog` row.
- A student exactly at the exam threshold (4 stripes): confirming advances `currentBelt` to the
  next belt, resets `currentStripes` to `0`, resets `beltAwardedAt` to (approximately) now, writes
  a `Promotion` row reflecting the belt change, and an `AuditLog` row.
- **The stale-eligibility race check**: seed a student who was eligible, then apply a negative
  `AttendanceRecord` adjustment that drops them back below the threshold *before* calling
  `confirmPromotion` — the action must reject (`{error: "notEligible"}` or similar), write NO
  `Promotion` row, and leave `Student` unchanged. This is the single most important test in this
  file — it's what proves the action recomputes eligibility fresh rather than trusting a
  client-submitted `toBelt`/`toStripes`.
- An INSTRUCTOR session is rejected (role gate) — spec §3 explicitly excludes INSTRUCTOR from
  promotions, unlike Phase 3's wider attendance-adjustment grant.
- A DIRECTOR whose `StaffAssignment` doesn't cover the target student's academy is rejected with
  `notFound` (out-of-scope check, same house rule as every prior write action).
- A student who is merely `"approaching"` (not yet at a threshold) is rejected the same way as the
  stale-eligibility case — confirming must never be possible for a student who was never actually
  eligible, regardless of how the request was constructed.

- [ ] **Step 2: Run to confirm it fails**

Run: `pnpm test:integration tests/integration/promotion-actions.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement `confirmPromotion`**

`"use server"`. `requireStaffSession(["ADMIN", "DIRECTOR"])`. Validate `studentId` via zod
(`z.object({ studentId: z.string().min(1) })` — no other client-submitted field is trusted for
the actual promotion decision; an optional `notes` field may also be accepted and passed through
to `Promotion.notes`). Re-fetch the student (`currentBelt`, `currentStripes`, `homeAcademyId`,
`beltAwardedAt`), re-check `isAcademyInScope(session, student.homeAcademyId)` → `{error:
"notFound"}` if out of scope. Recompute fresh: `getAtBeltSummary(student.id)` +
`resolveBeltRequirementLike` (reuse Task 2's helper, or extract it into a shared location if that
avoids duplication — your call, document it) + `classifyEligibility` + `resolvePromotionTarget`.
If `resolvePromotionTarget` returns `null` (status is `"approaching"` or `"none"`), return
`{error: "notEligible"}` — no DB write. Otherwise, in one `prisma.$transaction`:
1. `tx.promotion.create({ data: { studentId, academyId: student.homeAcademyId, fromBelt:
   target.fromBelt, fromStripes: target.fromStripes, toBelt: target.toBelt, toStripes:
   target.toStripes, awardedById: session.userId, notes: data.notes || null } })`
2. `tx.student.update({ where: { id: student.id }, data: target.kind === "belt" ? { currentBelt:
   target.toBelt, currentStripes: 0, beltAwardedAt: new Date() } : { currentStripes:
   target.toStripes } })` — note this is a plain `update`, not `updateMany` + count-check, because
   the scope check already happened above via a fresh `findUnique` + `isAcademyInScope`
   immediately before the transaction opens (matching Task 4's admin kiosk-token pattern from
   Phase 3 for a similarly-shaped single-row update after an upfront scope check — NOT the
   `updateMany`-with-race-guard pattern used for fields a *user-facing form* submits, since there
   is no client-submitted "which row" ambiguity here beyond the `studentId` already validated
   against scope).
3. `tx.auditLog.create({ data: { actorId: session.userId, academyId: student.homeAcademyId,
   action: "student.promote", entityType: "Student", entityId: student.id, before: { belt:
   student.currentBelt, stripes: student.currentStripes }, after: { belt: target.toBelt, stripes:
   target.toStripes } } })`

Return `{ok: true}`.

- [ ] **Step 4: Run to confirm it passes**

Run: `pnpm test:integration tests/integration/promotion-actions.test.ts`
Expected: PASS, all cases including the stale-eligibility race check.

- [ ] **Step 5: Commit**

```bash
git add src/app/[locale]/dashboard/promotion-actions.ts tests/integration/promotion-actions.test.ts
git commit -m "feat: add promotion confirmation action with fresh-eligibility race guard"
git push origin feat/phase-4-progression
```

---

### Task 4: Dashboard UI — promotion queue and approaching sections

**Files:**
- Modify: `src/app/[locale]/dashboard/page.tsx`, `messages/es.json`, `messages/en.json`
- Create: `src/app/[locale]/dashboard/confirm-promotion-button.tsx`

**Interfaces:**
- Consumes: `listPromotionQueue`, `listApproachingStudents` (Task 2), `confirmPromotion` (Task 3).

- [ ] **Step 1: Add the promotion queue section to the dashboard**

In `page.tsx` (already a Server Component reading `staffSession`/`scope`), call
`listPromotionQueue(staffSession)` and `listApproachingStudents(staffSession)` alongside the
existing `pendingCount` query. Render a "Promotion queue" section: one row per candidate (name,
belt graphic or plain belt+stripe text — reuse `BeltGraphic` if it fits cleanly, plain text is
fine if not, your call), showing `status` (stripe vs. exam) and, for ADMIN/DIRECTOR only, a
`ConfirmPromotionButton`. INSTRUCTOR sessions see the same list with no button (spec §3: "view
eligibility. No payments, no promotions") — gate the button the same way `canEdit` gates
edit/archive on the student detail page (`session.role === "ADMIN" || session.role ===
"DIRECTOR"`), NOT by omitting rows, since INSTRUCTOR must still be able to see who's eligible.

Render an "Approaching" section the same way, using `listApproachingStudents`, with no confirm
button ever (nothing in this list is actually confirmable yet — `resolvePromotionTarget` would
reject it anyway, but don't offer a button that always fails).

`ConfirmPromotionButton` (`"use client"`): `useActionState(confirmPromotion, initialState)`,
following this codebase's established button-with-confirm pattern (check
`archive-student-button.tsx` or `regenerate-code-button.tsx` from Phase 2 for the exact
`useActionState` + `<form action={formAction}>` + error-rendering convention). A plain confirm is
fine — spec doesn't ask for a "are you sure" dialog here the way archiving does, since a
promotion isn't destructive and has full audit history; your call if you want one anyway for
consistency, document it either way.

- [ ] **Step 2: Add message keys**

Add keys under `dashboard.promotionQueue.*` and `dashboard.approaching.*` in both `messages/en.json`
and `messages/es.json` (heading, empty-state text, column labels, the confirm button label, and
an `error.notEligible` message for the race-guard rejection).

- [ ] **Step 3: Manual verification**

Run: `pnpm build` — succeeds. Manually verify with `pnpm dev`: seed or adjust a student to exactly
a stripe threshold (via the existing `AddAdjustmentForm` from Phase 3, or a direct DB script),
confirm they appear in the queue, click confirm, confirm the belt graphic/stripe count updates on
their detail page and a `Promotion` row now exists.

- [ ] **Step 4: Commit**

```bash
git add -A -- ':!.agents' ':!.windsurf' ':!skills-lock.json'
git commit -m "feat: add promotion queue and approaching-students dashboard sections"
git push origin feat/phase-4-progression
```

---

### Task 5: Promotion history on the student detail page

**Files:**
- Modify: `src/app/[locale]/students/[id]/page.tsx`, `messages/es.json`, `messages/en.json`
- Create: `src/app/[locale]/students/[id]/get-promotion-history.ts` (plain Prisma read — check
  whether this needs to be a separate file from `page.tsx` per the established plain-function-vs-
  `"use server"`-action file-split rule; `page.tsx` is a Server Component reading this directly,
  not a client component importing a `"use server"` file, so the split likely does NOT apply
  here — verify with `pnpm build` and a client-bundle check the way Task 9 of Phase 3 did before
  assuming either way, and document your conclusion)

**Interfaces:**
- Produces: `getPromotionHistory(studentId: string): Promise<Array<{ id: string; fromBelt: Belt;
  fromStripes: number; toBelt: Belt; toStripes: number; awardedAt: Date; awardedByName: string;
  notes: string | null }>>` — ordered `awardedAt` descending.

- [ ] **Step 1: Implement the query**

`prisma.promotion.findMany({ where: { studentId }, orderBy: { awardedAt: "desc" }, include: {
awardedBy: { select: { ... } } } })` — check `User`'s actual display-name field (likely
`displayName` or similar; grep the schema/existing code for how a staff member's name is already
rendered elsewhere, e.g. in `AttendanceRecord.createdById`'s display if shown anywhere, or the
`awardedById` relation's real selectable field) and select only what's needed for
`awardedByName`.

- [ ] **Step 2: Replace the placeholder card**

In `page.tsx`, replace the `promotionHistory` card's `{tDetail("comingLater")}` body with a real
list: one row per promotion, showing date (in the academy's timezone, same
`formatTimestampInAcademyZone` helper already in this file), `fromBelt fromStripes → toBelt
toStripes`, `awardedByName`, and `notes` if present. An empty list shows a clear "no promotions
yet" message (add a new key, don't reuse `comingLater` — that phrase specifically means "this
feature doesn't exist yet," which is no longer true).

- [ ] **Step 3: Add message keys**

Add `students.detail.promotionHistory.{empty, columnDate, columnChange, columnBy, columnNotes}`
(or equivalent) to both locale files, removing the now-unused reliance on `comingLater` for this
specific card only (the other two placeholder cards — attendance history, payment history — keep
using `comingLater`, since those are still genuinely not built).

- [ ] **Step 4: Verify and commit**

Run: `pnpm build` — succeeds. Manually confirm a promoted student (from Task 4's manual test)
shows their promotion in this list.

```bash
git add -A -- ':!.agents' ':!.windsurf' ':!skills-lock.json'
git commit -m "feat: show real promotion history on the student detail page"
git push origin feat/phase-4-progression
```

---

### Task 6: Full-suite verification and PR prep

**Files:** none (verification only).

- [ ] **Step 1: Full-suite verification**

```bash
pnpm db:down
pnpm db:up
pnpm db:migrate
pnpm exec prisma generate
pnpm db:seed
pnpm test
pnpm build
pnpm lint
npx tsc --noEmit
```

All must pass/succeed. (No new migration is expected this phase — `Promotion` and
`BeltRequirement` both already exist from Phase 1 — so `pnpm db:migrate` should report no pending
migrations; if it reports one, that's a signal something in this plan was implemented incorrectly
as a schema change when it shouldn't have been.)

- [ ] **Step 2: Manual end-to-end walk**

Walk the whole phase once more: seed/adjust a student to a stripe threshold → confirm from the
dashboard queue as DIRECTOR → verify the belt graphic and promotion history update on their
detail page → adjust another student to the exam threshold → confirm → verify their belt actually
changed and stripes reset to 0 → attempt to confirm an "approaching" student directly against the
action (bypassing the UI, e.g. via a script) and confirm it's rejected → confirm an INSTRUCTOR
session cannot see a confirm button and cannot successfully call the action directly.

- [ ] **Step 3: Commit, push, prepare for final review**

```bash
git add -A -- ':!.agents' ':!.windsurf' ':!skills-lock.json'
git commit -m "test: full-suite verification for Phase 4"
git push origin feat/phase-4-progression
```

Phase 4 is complete once this task's full-suite verification passes. This plan's controller will
dispatch a final whole-branch review before opening a PR — do not open the PR yourself.
