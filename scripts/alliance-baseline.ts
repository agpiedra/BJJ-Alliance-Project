/**
 * Phase 0 of docs/MULTI_ACADEMY_AND_KIDS_BELTS.md — captures a read-only
 * snapshot of the live Alliance data before any multi-org migration touches
 * it. Every later phase's parity check compares its own state against this
 * file.
 *
 * READ-ONLY BY DESIGN:
 * - Never imports the app's `@/lib/prisma` singleton or any route/action —
 *   it opens its own PrismaClient against exactly the connection string it
 *   is given, so there is no risk of an ambient `DATABASE_URL` (dev, CI, or
 *   otherwise) being used by accident.
 * - The target must be passed explicitly via --database-url=<url> or the
 *   BASELINE_DATABASE_URL env var. The plain `DATABASE_URL` env var is
 *   deliberately never read as a fallback.
 * - The entire capture runs inside one Postgres transaction via
 *   scripts/lib/read-only-transaction.ts's runReadOnly(), which issues
 *   `SET TRANSACTION READ ONLY` as the first statement (before any data
 *   query) and verifies `SHOW transaction_read_only` before proceeding, so a
 *   coding mistake that attempted a write would fail at the database level,
 *   not just by convention. See tests/integration/read-only-transaction.test.ts.
 *
 * Usage:
 *   pnpm baseline:alliance -- --database-url="postgres://user:pass@host/db"
 *   BASELINE_DATABASE_URL="postgres://..." pnpm baseline:alliance
 */
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DateTime } from "luxon";
import { PrismaClient, type Prisma } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { runReadOnly } from "./lib/read-only-transaction";

// Duplicated literals, not imported from the app, to keep this script's only
// dependency the generated Prisma client — see the read-only note above.
// Keep these in sync with src/lib/scheduling/zone.ts's ZONE export and
// dashboard/page.tsx's WEEKLY_CHART_WINDOW_WEEKS if either changes.
const ZONE = "America/Costa_Rica";
const WEEKLY_CHART_WINDOW_WEEKS = 8;

const BELT_ORDER = ["WHITE", "BLUE", "PURPLE", "BROWN", "BLACK"] as const;

function resolveDatabaseUrl(): string {
  const flag = process.argv.find((arg) => arg.startsWith("--database-url="));
  const fromFlag = flag?.slice("--database-url=".length);
  const fromEnv = process.env.BASELINE_DATABASE_URL;
  const url = fromFlag || fromEnv;
  if (!url) {
    throw new Error(
      "Missing explicit database target. Pass --database-url=<connection-string> " +
        "or set BASELINE_DATABASE_URL. The plain DATABASE_URL env var is never used " +
        "implicitly by this script.",
    );
  }
  return url;
}

/** Optional override of the default baselines/alliance-<date>.json path —
 * used by the CI parity check (scripts/ci-parity-check.ts) to capture two
 * distinct, comparable snapshots (pre/post "migrate") in one run. */
function resolveOutPathOverride(): string | undefined {
  const flag = process.argv.find((arg) => arg.startsWith("--out="));
  return flag?.slice("--out=".length);
}

/** Host/port/db only — never logs or persists credentials. */
function redactedTarget(databaseUrl: string): string {
  try {
    const parsed = new URL(databaseUrl);
    return `${parsed.hostname}:${parsed.port || "5432"}${parsed.pathname}`;
  } catch {
    return "<unparseable-url>";
  }
}

/**
 * Mirrors src/lib/students/attendance-summary.ts's PROMOTION_RELEVANT filter
 * exactly (including the Phase 9 UNMATCHED exclusion) so this baseline's
 * per-student "promotion-relevant" total means the same thing the app's own
 * belt-progress math means. Duplicated rather than imported for the same
 * reason as ZONE above — see the file header.
 */
function promotionRelevantWhere(studentId: string, beltAwardedAt: Date): Prisma.AttendanceRecordWhereInput {
  return {
    studentId,
    occurredAt: { gte: beltAwardedAt },
    OR: [
      { classSessionId: null, NOT: { matchSource: "UNMATCHED" } },
      { classSession: { countsTowardPromotion: true } },
    ],
  };
}

type Tx = Prisma.TransactionClient;

interface HasIdFindMany {
  findMany: (args: { select: { id: true } }) => Promise<Array<{ id: string }>>;
}

async function idsAndCount(model: HasIdFindMany): Promise<{ count: number; ids: string[] }> {
  const rows = await model.findMany({ select: { id: true } });
  return { count: rows.length, ids: rows.map((r) => r.id) };
}

async function buildDashboardTotals(tx: Tx, academyIds: string[], rankCodeById: Map<string, string>) {
  const now = DateTime.now().setZone(ZONE);
  const from = now.minus({ weeks: WEEKLY_CHART_WINDOW_WEEKS - 1 }).startOf("week");
  const to = now.endOf("day");

  async function forScope(academyId: string | null) {
    const academyFilter = academyId ? { homeAcademyId: academyId } : {};
    const attendanceAcademyFilter = academyId ? { academyId } : {};

    const [activeStudents, totalStudents, beltGroups, attendances] = await Promise.all([
      tx.student.count({ where: { status: "ACTIVE", ...academyFilter } }),
      tx.student.count({ where: academyFilter }),
      // MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 2: groupBy can't group by a
      // relation (currentRank), only the scalar FK — resolved to a belt
      // code via rankCodeById below.
      tx.student.groupBy({
        by: ["currentRankId"],
        where: { status: "ACTIVE", ...academyFilter },
        _count: { _all: true },
      }),
      tx.attendanceRecord.findMany({
        where: {
          type: "CHECKIN",
          occurredAt: { gte: from.toJSDate(), lte: to.toJSDate() },
          ...attendanceAcademyFilter,
        },
        select: { occurredAt: true },
      }),
    ]);

    const beltDistribution = Object.fromEntries(BELT_ORDER.map((belt) => [belt, 0])) as Record<string, number>;
    for (const g of beltGroups) {
      const code = rankCodeById.get(g.currentRankId);
      if (code) beltDistribution[code] = (beltDistribution[code] ?? 0) + g._count._all;
    }

    const countByWeekStart = new Map<string, number>();
    for (const record of attendances) {
      const weekStart = DateTime.fromJSDate(record.occurredAt, { zone: ZONE }).startOf("week").toISODate()!;
      countByWeekStart.set(weekStart, (countByWeekStart.get(weekStart) ?? 0) + 1);
    }
    const weeklyAttendanceTrend: Array<{ weekStart: string; count: number }> = [];
    for (let week = from; week <= to.startOf("week"); week = week.plus({ weeks: 1 })) {
      const weekStart = week.toISODate()!;
      weeklyAttendanceTrend.push({ weekStart, count: countByWeekStart.get(weekStart) ?? 0 });
    }

    return { activeStudents, totalStudents, beltDistribution, weeklyAttendanceTrend };
  }

  const byAcademy: Record<string, Awaited<ReturnType<typeof forScope>>> = {};
  for (const academyId of academyIds) {
    byAcademy[academyId] = await forScope(academyId);
  }
  const overall = await forScope(null);

  return { window: { from: from.toISODate(), to: to.toISODate() }, byAcademy, overall };
}

async function buildSnapshot(tx: Tx, databaseUrl: string) {
  const [academies, staffAssignments, students, classSessions, promotions, beltRanks, paymentPlans] =
    await Promise.all([
      tx.academy.findMany({
        select: { id: true, name: true, slug: true, active: true, timezone: true, kioskTokenHash: true },
      }),
      tx.staffAssignment.findMany({ select: { id: true, userId: true, academyId: true, role: true } }),
      tx.student.findMany({
        select: {
          id: true,
          userId: true,
          homeAcademyId: true,
          status: true,
          track: true,
          currentRankId: true,
          currentRank: { select: { code: true } },
          currentStripes: true,
          beltAwardedAt: true,
          codeHash: true,
        },
      }),
      tx.classSession.findMany({
        select: {
          id: true,
          academyId: true,
          dayOfWeek: true,
          startTime: true,
          name: true,
          type: true,
          countsTowardPromotion: true,
          active: true,
        },
      }),
      tx.promotion.findMany({
        select: {
          id: true,
          studentId: true,
          academyId: true,
          fromRankId: true,
          fromRank: { select: { code: true } },
          fromStripes: true,
          toRankId: true,
          toRank: { select: { code: true } },
          toStripes: true,
          source: true,
          awardedById: true,
          awardedAt: true,
        },
      }),
      tx.beltRank.findMany({
        select: {
          id: true,
          organizationId: true,
          track: true,
          code: true,
          order: true,
          maxStripes: true,
          attendancesPerStripe: true,
          attendancesForExam: true,
          monthsPerStripe: true,
          monthsForExam: true,
          isTerminal: true,
        },
      }),
      tx.paymentPlan.findMany({ select: { id: true, academyId: true, name: true, active: true } }),
    ]);

  const paymentPeriods = await tx.paymentPeriod.findMany({
    select: {
      id: true,
      studentId: true,
      academyId: true,
      year: true,
      month: true,
      planId: true,
      status: true,
      amount: true,
      method: true,
      recordedById: true,
      recordedAt: true,
    },
  });

  // Lifetime totals for every student in one query; promotion-relevant totals
  // are per-student because each student's own beltAwardedAt anchors the
  // window (see promotionRelevantWhere). Alliance is two branches — this is a
  // one-off diagnostic run, not a hot path, so the per-student loop is fine.
  const lifetimeSums = await tx.attendanceRecord.groupBy({
    by: ["studentId"],
    _sum: { delta: true },
  });
  const lifetimeByStudent = new Map(lifetimeSums.map((s) => [s.studentId, s._sum.delta ?? 0]));

  const studentAttendance: Record<string, { lifetimeTotal: number; promotionRelevantSinceBeltAnchor: number }> = {};
  for (const student of students) {
    const promotionRelevantAgg = await tx.attendanceRecord.aggregate({
      where: promotionRelevantWhere(student.id, student.beltAwardedAt),
      _sum: { delta: true },
    });
    studentAttendance[student.id] = {
      lifetimeTotal: lifetimeByStudent.get(student.id) ?? 0,
      promotionRelevantSinceBeltAnchor: promotionRelevantAgg._sum.delta ?? 0,
    };
  }

  const [
    userCounts,
    attendanceCounts,
    kioskAttempts,
    auditLogs,
    notifications,
    passwordResetTokens,
  ] = await Promise.all([
    idsAndCount(tx.user),
    idsAndCount(tx.attendanceRecord),
    tx.kioskAttempt.findMany({
      select: { id: true, academyId: true, kioskTokenHash: true, success: true, countsAsFailure: true, createdAt: true },
    }),
    idsAndCount(tx.auditLog),
    idsAndCount(tx.notification),
    idsAndCount(tx.passwordResetToken),
  ]);

  const rankCodeById = new Map(beltRanks.map((r) => [r.id, r.code]));
  const dashboardTotals = await buildDashboardTotals(
    tx,
    academies.map((a) => a.id),
    rankCodeById,
  );

  return {
    capturedAt: DateTime.now().setZone(ZONE).toISO(),
    databaseTarget: redactedTarget(databaseUrl),
    counts: {
      Academy: academies.length,
      User: userCounts.count,
      StaffAssignment: staffAssignments.length,
      Student: students.length,
      ClassSession: classSessions.length,
      AttendanceRecord: attendanceCounts.count,
      Promotion: promotions.length,
      BeltRank: beltRanks.length,
      PaymentPlan: paymentPlans.length,
      PaymentPeriod: paymentPeriods.length,
      KioskAttempt: kioskAttempts.length,
      AuditLog: auditLogs.count,
      Notification: notifications.count,
      PasswordResetToken: passwordResetTokens.count,
    },
    rowIds: {
      User: userCounts.ids,
      AttendanceRecord: attendanceCounts.ids,
      AuditLog: auditLogs.ids,
      Notification: notifications.ids,
      PasswordResetToken: passwordResetTokens.ids,
    },
    academies,
    staffAssignments,
    students: students.map((s) => ({
      ...s,
      beltAwardedAt: s.beltAwardedAt.toISOString(),
      attendanceDelta: studentAttendance[s.id],
    })),
    classSessions,
    promotions: promotions.map((p) => ({ ...p, awardedAt: p.awardedAt.toISOString() })),
    beltRanks,
    paymentPlans,
    paymentPeriods: paymentPeriods.map((p) => ({
      ...p,
      amount: p.amount === null ? null : p.amount.toString(),
      recordedAt: p.recordedAt.toISOString(),
    })),
    kioskAttempts: kioskAttempts.map((k) => ({ ...k, createdAt: k.createdAt.toISOString() })),
    dashboardTotals,
  };
}

async function main() {
  const databaseUrl = resolveDatabaseUrl();
  const target = redactedTarget(databaseUrl);
  console.log(`Alliance parity baseline — READ-ONLY capture against ${target}`);

  const adapter = new PrismaPg({ connectionString: databaseUrl });
  const prisma = new PrismaClient({ adapter });

  const snapshot = await runReadOnly(prisma, (tx) => buildSnapshot(tx, databaseUrl));

  await prisma.$disconnect();

  const override = resolveOutPathOverride();
  let outPath: string;
  if (override) {
    outPath = path.resolve(process.cwd(), override);
    mkdirSync(path.dirname(outPath), { recursive: true });
  } else {
    const dateStamp = DateTime.now().setZone(ZONE).toFormat("yyyyLLdd");
    const outDir = path.resolve(process.cwd(), "baselines");
    mkdirSync(outDir, { recursive: true });
    outPath = path.join(outDir, `alliance-${dateStamp}.json`);
  }
  writeFileSync(outPath, JSON.stringify(snapshot, null, 2));

  console.log(`Wrote ${outPath}`);
  console.log(`Counts: ${JSON.stringify(snapshot.counts, null, 2)}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
