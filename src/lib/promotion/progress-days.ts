import { Prisma } from "@/generated/prisma/client";
import type { prisma } from "@/lib/prisma";

/**
 * docs/PROMOTION_PROGRESS_PROPOSAL.md - the academy's decided attendance rule
 * for PER_INTERVAL accounting:
 *
 *  1. A student gets AT MOST ONE qualifying attendance per America/Costa_Rica
 *     calendar day, whatever the number of classes, entry channels (kiosk,
 *     portal, coach-added), retries or offline replays. The day is the ledger
 *     `AttendanceRecord.date`: for a check-in matched to a class it is that class
 *     occurrence's own CR day; for an unmatched/portal tap or a coach-added day it
 *     is the CR day being recorded. Never the UTC date, never the replay's arrival
 *     date (`createdAt`).
 *  2. Every row stays in the ledger. The daily contribution is DERIVED: the
 *     earliest qualifying row of the day (by `occurredAt`, then id) is that day's
 *     one contribution and the rest add 0. Deriving instead of storing a claim
 *     is what makes the limit hold for concurrent requests, retries and replays
 *     with no lock and no window: however many rows land in whatever order,
 *     the same set of rows always yields the same day-set, and reassigning a tap
 *     to a counting class or flipping a class's `countsTowardPromotion` needs no
 *     second bookkeeping step.
 *  3. A day belongs to the interval its FIRST qualifying row falls in
 *     (`from` <= firstAt < `until`). A promotion does not clear the daily limit:
 *     once a day already has a qualifying row before the award, another class
 *     after the award adds 0 to the new interval; and a late-recorded row from
 *     before the award keeps its own `occurredAt`, so it stays in the completed
 *     interval and adds nothing to the next.
 *
 * A row qualifies when it is not voided (an ADMIN/DIRECTOR invalidated it as a mistake; it stays in
 * the history but counts for nothing, and the day's contribution is recomputed from the remaining
 * rows), has a positive `delta` and either is a class-less
 * staff-added day (not an UNMATCHED tap) or belongs to a class flagged
 * `countsTowardPromotion`. Negative/zero adjustments never contribute - there is
 * no arbitrary progress credit, positive or negative.
 */

/** Either the guarded client or a transaction on it - both expose `$queryRaw`. */
type RawClient = Pick<typeof prisma, "$queryRaw">;

export interface ContributingDay {
  /** The Costa Rica ledger day, `YYYY-MM-DD`. */
  day: string;
  /** `occurredAt` of the row that is this day's one contribution. */
  firstAt: Date;
  /** That row's id - what the award audit records as evidence. */
  recordId: string;
}

/**
 * Shared by every query here so "what qualifies" is defined exactly once.
 * `a` = AttendanceRecord, `c` = its (optional) ClassSession.
 */
const QUALIFYING = Prisma.sql`
  a."voidedAt" IS NULL
  AND a."delta" > 0
  AND (
    (a."classSessionId" IS NULL AND a."matchSource" <> 'UNMATCHED')
    OR c."countsTowardPromotion" = true
  )`;

/**
 * An instant as an ISO string cast to a UTC wall-clock `timestamp`, matching how
 * `occurredAt` (`timestamp(3)` without time zone, always written as UTC) is
 * stored - so the comparison never depends on the database session's time zone
 * or on how a driver serializes a JS Date.
 */
function utcTimestamp(instant: Date): Prisma.Sql {
  return Prisma.sql`(${instant.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
}

/**
 * The contributing days of one student whose first qualifying attendance is in
 * `[from, until)` (`until` omitted = no upper bound), oldest day first. Scoped by
 * `organizationId` by hand: this is a raw query, outside the tenant guard.
 */
export async function listContributingDays(
  client: RawClient,
  params: { studentId: string; organizationId: string; from: Date; until?: Date },
): Promise<ContributingDay[]> {
  const upper = params.until ? Prisma.sql`AND firsts."occurredAt" < ${utcTimestamp(params.until)}` : Prisma.empty;
  const rows = await client.$queryRaw<Array<{ day: string; occurredAt: Date; id: string }>>(Prisma.sql`
    SELECT firsts."day", firsts."occurredAt", firsts."id"
    FROM (
      SELECT DISTINCT ON (a."date")
        to_char(a."date", 'YYYY-MM-DD') AS "day",
        a."occurredAt" AS "occurredAt",
        a."id" AS "id"
      FROM "AttendanceRecord" a
      LEFT JOIN "ClassSession" c
        ON c."id" = a."classSessionId" AND c."organizationId" = a."organizationId"
      WHERE a."studentId" = ${params.studentId}
        AND a."organizationId" = ${params.organizationId}
        AND ${QUALIFYING}
      ORDER BY a."date", a."occurredAt", a."id"
    ) firsts
    WHERE firsts."occurredAt" >= ${utcTimestamp(params.from)}
      ${upper}
    ORDER BY firsts."day"
  `);
  return rows.map((row) => ({ day: row.day, firstAt: row.occurredAt, recordId: row.id }));
}

/**
 * The `occurredAt` of the earliest qualifying (valid, non-voided) row of one Costa Rica ledger day
 * (`YYYY-MM-DD`), or null when the day has none. Used to place a day-only staff entry so it can never
 * become that day's earliest row and displace a real contribution.
 */
export async function earliestQualifyingAt(
  client: RawClient,
  params: { studentId: string; organizationId: string; day: string },
): Promise<Date | null> {
  const rows = await client.$queryRaw<Array<{ occurredAt: Date }>>(Prisma.sql`
    SELECT a."occurredAt" AS "occurredAt"
    FROM "AttendanceRecord" a
    LEFT JOIN "ClassSession" c
      ON c."id" = a."classSessionId" AND c."organizationId" = a."organizationId"
    WHERE a."studentId" = ${params.studentId}
      AND a."organizationId" = ${params.organizationId}
      AND a."date" = ${params.day}::date
      AND ${QUALIFYING}
    ORDER BY a."occurredAt", a."id"
    LIMIT 1
  `);
  return rows[0]?.occurredAt ?? null;
}

/**
 * Whether `recordId` is the contribution of its own day: true for the earliest
 * qualifying row of that ledger day, false when an earlier qualifying row
 * already made the day's contribution or when the row does not qualify at all
 * (unmatched tap, non-counting class). Used to tell a student, truthfully, that
 * an additional same-day check-in was recorded but added nothing.
 */
export async function isDayContribution(
  client: RawClient,
  params: { studentId: string; organizationId: string; recordId: string },
): Promise<boolean> {
  const rows = await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT a."id"
    FROM "AttendanceRecord" a
    LEFT JOIN "ClassSession" c
      ON c."id" = a."classSessionId" AND c."organizationId" = a."organizationId"
    WHERE a."studentId" = ${params.studentId}
      AND a."organizationId" = ${params.organizationId}
      AND a."date" = (
        SELECT t."date" FROM "AttendanceRecord" t
        WHERE t."id" = ${params.recordId} AND t."organizationId" = ${params.organizationId}
      )
      AND ${QUALIFYING}
    ORDER BY a."occurredAt", a."id"
    LIMIT 1
  `);
  return rows[0]?.id === params.recordId;
}
