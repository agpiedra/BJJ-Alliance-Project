import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { awaitingRateReceiptSnapshotSchema, type AwaitingRateReceiptSnapshot } from "@/lib/dues/ledger/awaiting-rate-receipt";

/**
 * Owner awaiting-rate receipt queue, read side (this feature's own planning brief). Plain module, no "use server"
 * directive — these are composition cores a "use server" action wraps after its own auth check, never independently
 * client-invocable themselves, matching `exchange-rate-queries.ts`'s own established shape.
 */

const STATUSES = ["PENDING", "RESOLVED", "CANCELLED"] as const;
export type AwaitingRateReceiptStatusFilter = (typeof STATUSES)[number];

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function clampLimit(limit: unknown): number {
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1) return DEFAULT_LIMIT;
  return Math.min(limit, MAX_LIMIT);
}

export type ProposalSummary =
  | { ok: true; existingObligationIds: string[]; proposedCoverage?: Array<{ year: number; month: number }> }
  | { ok: false; reason: "snapshotIntegrityFailure" };

export interface AwaitingRateReceiptRow {
  id: string;
  studentId: string;
  studentName: string;
  academyId: string;
  kind: "ORDINARY" | "PREPAYMENT" | "PACKAGE";
  status: "PENDING" | "RESOLVED" | "CANCELLED";
  receivedOn: { year: number; month: number; day: number };
  tenderCurrency: string;
  tenderAmount: string;
  method: string;
  notes: string | null;
  /** ISO instant, plain string — a `Date` object is never handed across the server-action boundary, same convention
   * `exchange-rate-queries.ts`'s own `ExchangeRateQuoteRow` follows. */
  capturedAt: string;
  capturedByEmail: string;
  resolvedAt: string | null;
  resolvedByEmail: string | null;
  cancelledAt: string | null;
  cancelledByEmail: string | null;
  cancellationReason: string | null;
  proposal: ProposalSummary;
}

function toDateParts(date: Date): { year: number; month: number; day: number } {
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

/**
 * Shapes a validated snapshot into what the UI actually displays — never the raw JSON. Two checks, both required
 * (this feature's own brief, correction #2): the snapshot must parse AND its own `kind` must agree with the row's
 * real `kind` column. Either failing produces an explicit integrity-failure state, never a silently empty summary.
 * `proposedCoverage` is read directly off the snapshot's own stored months — never derived from a `monthsCovered`
 * field (PACKAGE's snapshot has none) or from any live-fetched terms value.
 */
function summarizeProposal(snapshot: unknown, rowKind: string): ProposalSummary {
  const parsed = awaitingRateReceiptSnapshotSchema.safeParse(snapshot);
  if (!parsed.success || parsed.data.kind !== rowKind) return { ok: false, reason: "snapshotIntegrityFailure" };
  const data: AwaitingRateReceiptSnapshot = parsed.data;
  if (data.kind === "ORDINARY") return { ok: true, existingObligationIds: data.obligationIds };
  if (data.kind === "PREPAYMENT") {
    return {
      ok: true,
      existingObligationIds: data.existingObligationIds,
      proposedCoverage: data.months.map((m) => ({ year: m.coverage.year, month: m.coverage.month })),
    };
  }
  return { ok: true, existingObligationIds: data.existingObligationIds, proposedCoverage: data.coverageMonths };
}

/**
 * Bounded, cursor-paginated list of awaiting-rate receipts for one organization — real pagination (Prisma's native
 * `cursor`/`skip`/`take`), never a larger fetch trimmed client-side, so older PENDING receipts stay reachable no
 * matter how many exist. `capturedAt` alone is not unique (two receipts can be captured in the same instant), so
 * `id` is included as an explicit tie-break in `orderBy` — without it, cursor pagination is not well-defined and a
 * row could be skipped or repeated across pages.
 */
export async function listAwaitingRateReceipts(
  organizationId: string,
  args: { status?: AwaitingRateReceiptStatusFilter; limit?: number; cursor?: string } = {},
): Promise<{ rows: AwaitingRateReceiptRow[]; nextCursor: string | null }> {
  if (!isNonBlankString(organizationId)) return { rows: [], nextCursor: null };
  const status = args.status !== undefined && STATUSES.includes(args.status) ? args.status : undefined;
  const cursor = args.cursor !== undefined && isNonBlankString(args.cursor) ? args.cursor : undefined;
  const limit = clampLimit(args.limit);

  // Prisma's native `cursor` looks the id up by its own unique index, NOT scoped by `where` — a cursor naming a
  // real row that belongs to a DIFFERENT organization would still "work" (no P2025), silently paginating org A's
  // own results from a position derived from org B's row. Verified here first so a foreign cursor is treated
  // identically to a nonexistent one: an empty page, never a cross-organization position leak.
  if (cursor) {
    const owns = await prisma.awaitingRateReceipt.findFirst({ where: { id: cursor, organizationId }, select: { id: true } });
    if (!owns) return { rows: [], nextCursor: null };
  }

  let rows;
  try {
    rows = await prisma.awaitingRateReceipt.findMany({
      where: { organizationId, ...(status ? { status } : {}) },
      orderBy: [{ capturedAt: "desc" }, { id: "desc" }],
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      take: limit,
      select: {
        id: true,
        studentId: true,
        student: { select: { firstName: true, lastName: true } },
        academyId: true,
        kind: true,
        status: true,
        receivedOn: true,
        tenderCurrency: true,
        tenderAmount: true,
        method: true,
        notes: true,
        capturedAt: true,
        capturedBy: { select: { email: true } },
        resolvedAt: true,
        resolvedBy: { select: { email: true } },
        cancelledAt: true,
        cancelledBy: { select: { email: true } },
        cancellationReason: true,
        snapshot: true,
      },
    });
  } catch (error) {
    // A cursor naming an id that no longer exists (cannot actually happen for this table) or belongs to a different
    // organization (the `where` scopes the query but not the cursor lookup itself, which Prisma resolves against the
    // bare id) throws P2025 ("record to cursor on not found") — treated as "no more results," never an uncaught
    // exception reaching the action layer.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") return { rows: [], nextCursor: null };
    throw error;
  }

  const mapped: AwaitingRateReceiptRow[] = rows.map((row) => ({
    id: row.id,
    studentId: row.studentId,
    studentName: `${row.student.firstName} ${row.student.lastName}`,
    academyId: row.academyId,
    kind: row.kind,
    status: row.status,
    receivedOn: toDateParts(row.receivedOn),
    tenderCurrency: row.tenderCurrency,
    tenderAmount: row.tenderAmount.toFixed(2),
    method: row.method,
    notes: row.notes,
    capturedAt: row.capturedAt.toISOString(),
    capturedByEmail: row.capturedBy.email,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    resolvedByEmail: row.resolvedBy?.email ?? null,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    cancelledByEmail: row.cancelledBy?.email ?? null,
    cancellationReason: row.cancellationReason,
    proposal: summarizeProposal(row.snapshot, row.kind),
  }));

  return { rows: mapped, nextCursor: rows.length === limit ? rows[rows.length - 1].id : null };
}

/** The terminal-status-refresh read behind `getReceiptStatus` — scoped by BOTH `organizationId` and `id`, same
 * non-blank-string guard as every other reader here. Never trusts a bare id without the organization scope. */
export async function findReceiptStatus(organizationId: string, receiptId: string): Promise<{ status: "PENDING" | "RESOLVED" | "CANCELLED" } | null> {
  if (!isNonBlankString(organizationId) || !isNonBlankString(receiptId)) return null;
  const row = await prisma.awaitingRateReceipt.findFirst({ where: { id: receiptId, organizationId }, select: { status: true } });
  return row ? { status: row.status } : null;
}
