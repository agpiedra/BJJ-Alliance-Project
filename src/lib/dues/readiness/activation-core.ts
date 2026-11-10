import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import type { Tx } from "@/lib/students/lock";
import type { YearMonth } from "@/lib/dues/calendar";
import type { TenantContext } from "@/lib/tenant/types";
import { isLockTimeout, lockOrganizationGate } from "@/lib/dues/activation-gate";
import { activationWindow, isCandidateMonth } from "@/lib/dues/readiness/candidate";
import { evaluateReadiness, openingTotalsByStudent, studentsNeedingRefresh, type ReadinessReport } from "@/lib/dues/readiness/evaluate";
import { FINGERPRINT_FORMAT } from "@/lib/dues/readiness/fingerprint";
import { loadReadinessSnapshot, type ReadinessSnapshot } from "@/lib/dues/readiness/snapshot";

/**
 * Stage 9 PR 9-3 (docs/dues/STAGE-9-IMPLEMENTATION-PLAN.md; A1–A8 approved 2026-11-10): advance approval, withdrawal and the
 * owner-initiated atomic switch. Deliberately NOT a "use server" file: every function trusts an already-authorized OWNER context
 * (`activation-actions.ts` authorizes `ADMIN` and is the only public surface).
 *
 * Each runs in ONE READ COMMITTED transaction whose first lock is the organization gate in its exclusive mode (`FOR NO KEY
 * UPDATE`, approved): every writer of what readiness reads holds the gate `FOR SHARE` first (PR 9-1), so once it is granted
 * nothing reviewed can change until commit, and every later statement sees every commit made before the grant (READ COMMITTED
 * takes a fresh snapshot per statement; REPEATABLE READ would have fixed it before the lock wait). Readiness is recomputed inside
 * the transaction from that state. JobRun (check 10) is the one input outside the gate: it is read as it is at that moment.
 *
 * Nothing pauses any payment (A1, A5): the only wait any writer sees is this transaction, bounded by `SWITCH_BOUNDS`. Any refusal
 * or error rolls back everything; nothing is left blocked.
 *
 * `deps` hooks are TEST-ONLY (the `LedgerDeps` convention): production passes none.
 */
export const SWITCH_BOUNDS = { lockTimeoutMs: 5_000, statementTimeoutMs: 15_000, maxWaitMs: 5_000, timeoutMs: 30_000 } as const;

export interface ActivationDeps {
  /** The clock. Tests fix it; production leaves it out. */
  now?: () => Date;
  /** TEST-ONLY: replaces check 10's trigger facts (a test cannot schedule the real job). Never set in production. */
  triggerForTest?: ReadinessSnapshot["trigger"];
  /** TEST-ONLY: called right after the gate is granted, with the open transaction (pause point for race proofs). */
  afterGateForTest?: (tx: Tx) => Promise<void>;
  /** TEST-ONLY: called after every write, before COMMIT (failure injection for the rollback proof). */
  beforeCommitForTest?: (tx: Tx) => Promise<void>;
}

export type FailingCheck = { id: number; key: string; items: string[] };

export type ApproveResult =
  | { ok: true; approvalId: string }
  | {
      ok: false;
      error: "notFound" | "invalid" | "alreadyActive" | "approvalExists" | "tooLate" | "stale" | "notReady" | "busy";
      failing?: FailingCheck[];
    };

export type WithdrawResult = { ok: true } | { ok: false; error: "notFound" | "alreadyActive" | "noApproval" | "busy" };

export type ActivateResult =
  | { ok: true; effectiveAt: Date; startYear: number; startMonth: number; openingObligations: number; refreshedStudents: string[] }
  | {
      ok: false;
      error:
        | "notFound"
        | "alreadyActive"
        | "noApproval"
        | "windowNotOpen"
        | "windowClosed"
        | "configurationChanged"
        | "notReady"
        | "needsReconfirmation"
        | "progressRowExists"
        | "busy";
      failing?: FailingCheck[];
      students?: string[];
    };

type Refusal<R> = { refusal: R };
const refusal = <R>(r: R): Refusal<R> => ({ refusal: r });
const isRefusal = <R>(v: unknown): v is Refusal<R> => typeof v === "object" && v !== null && "refusal" in v;

async function bounded<T>(body: (tx: Tx) => Promise<T>): Promise<T> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = ${SWITCH_BOUNDS.lockTimeoutMs}`);
      await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${SWITCH_BOUNDS.statementTimeoutMs}`);
      return body(tx);
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: SWITCH_BOUNDS.maxWaitMs, timeout: SWITCH_BOUNDS.timeoutMs },
  );
}

async function readiness(tx: Tx, organizationId: string, s: YearMonth, deps: ActivationDeps): Promise<{ snapshot: ReadinessSnapshot; report: ReadinessReport }> {
  const loaded = await loadReadinessSnapshot(tx, organizationId);
  const snapshot = deps.triggerForTest ? { ...loaded, trigger: deps.triggerForTest } : loaded;
  return { snapshot, report: evaluateReadiness(snapshot, s) };
}

const failingChecks = (report: ReadinessReport): FailingCheck[] =>
  report.checks.filter((c) => c.status !== "pass").map(({ id, key, items }) => ({ id, key, items }));

const ym = (s: YearMonth) => `${s.year}-${String(s.month).padStart(2, "0")}`;

/**
 * Rule 2 (approved): only before the FIRST branch reaches local 00:00 on the 1st of S, only with no blockers, and only for the
 * report the owner was shown (`organizationFingerprint` must equal the one recomputed under the gate, else `stale`). Stores S, the
 * configuration fingerprint, every student's fingerprint and opening totals, the approver and the time. Switches nothing.
 * Rule 3: one live approval per organization (database); a new one requires the previous one withdrawn.
 */
export async function approveActivationCore(
  context: TenantContext,
  input: { candidate: YearMonth; organizationFingerprint: string },
  deps: ActivationDeps = {},
): Promise<ApproveResult> {
  if (!isCandidateMonth(input.candidate)) return { ok: false, error: "invalid" };
  const organizationId = context.organizationId;
  try {
    const out = await bounded(async (tx) => {
      const gate = await lockOrganizationGate(tx, organizationId, "update");
      if (!gate) return refusal<ApproveResult>({ ok: false, error: "notFound" });
      await deps.afterGateForTest?.(tx);
      if (gate.active) return refusal<ApproveResult>({ ok: false, error: "alreadyActive" });
      const live = await tx.duesActivation.findFirst({ where: { organizationId, withdrawnAt: null }, select: { id: true } });
      if (live) return refusal<ApproveResult>({ ok: false, error: "approvalExists" });

      const now = (deps.now ?? (() => new Date()))();
      const { snapshot, report } = await readiness(tx, organizationId, input.candidate, deps);
      const window = activationWindow(input.candidate, snapshot.branches.map((b) => b.timezone));
      if (!window) return refusal<ApproveResult>({ ok: false, error: "invalid" });
      if (now.getTime() >= window.approvalDeadline.getTime()) return refusal<ApproveResult>({ ok: false, error: "tooLate" });
      if (report.fingerprints.organization !== input.organizationFingerprint) return refusal<ApproveResult>({ ok: false, error: "stale" });
      if (!report.ready) return refusal<ApproveResult>({ ok: false, error: "notReady", failing: failingChecks(report) });

      const created = await tx.duesActivation.create({
        data: {
          organizationId,
          startYear: input.candidate.year,
          startMonth: input.candidate.month,
          fingerprintFormat: FINGERPRINT_FORMAT,
          configFingerprint: report.fingerprints.configuration,
          studentFingerprints: report.fingerprints.students,
          approvedOpeningTotals: openingTotalsByStudent(snapshot),
          approvedById: context.actorUserId,
          approvedAt: now,
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: context.actorUserId,
          organizationId,
          action: "duesActivation.approve",
          entityType: "DuesActivation",
          entityId: created.id,
          before: Prisma.DbNull,
          after: { start: ym(input.candidate), configFingerprint: report.fingerprints.configuration, students: snapshot.students.length, approvedAt: now.toISOString() },
        },
      });
      await deps.beforeCommitForTest?.(tx);
      return { ok: true as const, approvalId: created.id };
    });
    return isRefusal<ApproveResult>(out) ? out.refusal : out;
  } catch (error) {
    if (isLockTimeout(error)) return { ok: false, error: "busy" };
    throw error;
  }
}

/** Rule 3: the owner may withdraw the live approval at any time before the switch. Set once (database). */
export async function withdrawApprovalCore(context: TenantContext, deps: ActivationDeps = {}): Promise<WithdrawResult> {
  const organizationId = context.organizationId;
  try {
    const out = await bounded(async (tx) => {
      const gate = await lockOrganizationGate(tx, organizationId, "update");
      if (!gate) return refusal<WithdrawResult>({ ok: false, error: "notFound" });
      await deps.afterGateForTest?.(tx);
      if (gate.active) return refusal<WithdrawResult>({ ok: false, error: "alreadyActive" });
      const live = await tx.duesActivation.findFirst({ where: { organizationId, withdrawnAt: null }, select: { id: true, startYear: true, startMonth: true } });
      if (!live) return refusal<WithdrawResult>({ ok: false, error: "noApproval" });
      const now = (deps.now ?? (() => new Date()))();
      await tx.duesActivation.update({ where: { id: live.id, organizationId }, data: { withdrawnAt: now, withdrawnById: context.actorUserId } });
      await tx.auditLog.create({
        data: {
          actorId: context.actorUserId,
          organizationId,
          action: "duesActivation.withdraw",
          entityType: "DuesActivation",
          entityId: live.id,
          before: { withdrawnAt: null },
          after: { start: ym({ year: live.startYear, month: live.startMonth }), withdrawnAt: now.toISOString() },
        },
      });
      await deps.beforeCommitForTest?.(tx);
      return { ok: true as const };
    });
    return isRefusal<WithdrawResult>(out) ? out.refusal : out;
  } catch (error) {
    if (isLockTimeout(error)) return { ok: false, error: "busy" };
    throw error;
  }
}

/**
 * Rules 4–7, one transaction: the gate exclusively first; refuse if already active, no live approval, or outside the window;
 * recompute readiness for the approved S; the configuration fingerprint must equal the approval; every changed student must be
 * refreshed (above); no blocker (check 5 classifies old-system rows for S and later under the gate, A8); then create one OPENING
 * obligation per active opening item and link it (`materializedObligationId`), insert the first progress row for S, make the
 * activation effective, audit; commit. From the commit the legacy writers refuse (they read the activation under the gate), the
 * ledger writers accept, and monthly generation may run for S (`generationStart`). No undo (A5).
 */
export async function activateCore(context: TenantContext, deps: ActivationDeps = {}): Promise<ActivateResult> {
  const organizationId = context.organizationId;
  try {
    const out = await bounded(async (tx) => {
      const gate = await lockOrganizationGate(tx, organizationId, "update");
      if (!gate) return refusal<ActivateResult>({ ok: false, error: "notFound" });
      await deps.afterGateForTest?.(tx);
      if (gate.active) return refusal<ActivateResult>({ ok: false, error: "alreadyActive" });
      const approval = await tx.duesActivation.findFirst({ where: { organizationId, withdrawnAt: null } });
      if (!approval) return refusal<ActivateResult>({ ok: false, error: "noApproval" });

      const s = { year: approval.startYear, month: approval.startMonth };
      const now = (deps.now ?? (() => new Date()))();
      const { snapshot, report } = await readiness(tx, organizationId, s, deps);
      const window = activationWindow(s, snapshot.branches.map((b) => b.timezone));
      if (!window || now.getTime() < window.opensAt.getTime()) return refusal<ActivateResult>({ ok: false, error: "windowNotOpen" });
      if (now.getTime() >= window.closesAt.getTime()) return refusal<ActivateResult>({ ok: false, error: "windowClosed" });
      if (approval.fingerprintFormat !== FINGERPRINT_FORMAT || approval.configFingerprint !== report.fingerprints.configuration) {
        return refusal<ActivateResult>({ ok: false, error: "configurationChanged" });
      }
      const approvedFps = approval.studentFingerprints as Record<string, string>;
      const refresh = studentsNeedingRefresh({ studentFingerprints: approvedFps, approvedAt: approval.approvedAt }, snapshot, report);
      if (refresh.notRefreshed.length > 0) return refusal<ActivateResult>({ ok: false, error: "needsReconfirmation", students: refresh.notRefreshed });
      if (!report.ready) return refusal<ActivateResult>({ ok: false, error: "notReady", failing: failingChecks(report) });
      const existingProgress = await tx.duesGenerationProgress.findFirst({ where: { organizationId }, select: { id: true } });
      if (existingProgress) return refusal<ActivateResult>({ ok: false, error: "progressRowExists" });

      // The reviewed opening debt (check 9 made every one of these students' current review valid): one OPENING obligation per
      // ACTIVE opening item, at the student's current home branch, linked back to the item (database-checked: same content).
      const homeOf = new Map(snapshot.students.map((st) => [st.id, st.homeAcademyId]));
      const items = [...snapshot.openingItems].sort((a, b) => (a.id < b.id ? -1 : 1));
      for (const item of items) {
        const obligation = await tx.duesObligation.create({
          data: {
            organizationId,
            studentId: item.studentId,
            academyId: homeOf.get(item.studentId)!,
            type: "OPENING",
            origin: "STAFF",
            coverageYear: item.coverageYear,
            coverageMonth: item.coverageMonth,
            monthsCovered: 1,
            amount: item.amount,
            currency: item.currency as Prisma.DuesObligationCreateManyInput["currency"],
            createdById: context.actorUserId,
          },
          select: { id: true },
        });
        await tx.duesOpeningItem.update({ where: { id: item.id, organizationId }, data: { materializedObligationId: obligation.id } });
      }
      await tx.duesGenerationProgress.create({ data: { organizationId, year: s.year, month: s.month, lastVisitedAt: new Date(0) } });
      await tx.duesActivation.update({ where: { id: approval.id, organizationId }, data: { effectiveAt: now, effectiveById: context.actorUserId } });
      await tx.auditLog.create({
        data: {
          actorId: context.actorUserId,
          organizationId,
          action: "duesActivation.activate",
          entityType: "DuesActivation",
          entityId: approval.id,
          before: { effectiveAt: null },
          after: {
            start: ym(s),
            effectiveAt: now.toISOString(),
            openingObligations: items.length,
            refreshedStudents: refresh.changed,
            legacyPlaceholders: report.legacyFromStart.filter((r) => r.classification === "placeholder").map((r) => r.legacyId),
            acknowledgedNoMoney: report.legacyFromStart.filter((r) => r.acknowledgement?.state === "valid").map((r) => r.legacyId),
          },
        },
      });
      await deps.beforeCommitForTest?.(tx);
      return { ok: true as const, effectiveAt: now, startYear: s.year, startMonth: s.month, openingObligations: items.length, refreshedStudents: refresh.changed };
    });
    return isRefusal<ActivateResult>(out) ? out.refusal : out;
  } catch (error) {
    if (isLockTimeout(error)) return { ok: false, error: "busy" };
    throw error;
  }
}
