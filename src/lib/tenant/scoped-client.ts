import { unscopedPrisma } from "@/lib/prisma/unscoped";
import type { PrismaClient } from "@/generated/prisma/client";
import type { AccessContext } from "./types";

/**
 * Every model that carries `organizationId` and is reachable through the
 * tenant-scoped client. Deliberately excludes `Organization`,
 * `OrganizationMembership`, `User`, `PasswordResetToken`, and `AuditLog` —
 * those stay behind the separate platform/global data-access module the
 * spec calls for (authentication, membership resolution, platform admin,
 * public org discovery, migrations/seeds). Reaching for them through this
 * wrapper is refused at runtime, not merely undocumented.
 */
export const TENANT_SCOPED_MODELS = new Set([
  "Academy",
  "Student",
  "ClassSession",
  "AttendanceRecord",
  "Promotion",
  "PromotionCredit",
  "BeltRank",
  "PromotionConfig",
  "PaymentPlan",
  "PaymentPeriod",
  "KioskAttempt",
  "StaffAssignment",
  "Notification",
]);

const WHERE_SCOPED_OPERATIONS = new Set([
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "count",
  "aggregate",
  "groupBy",
  "update",
  "updateMany",
  "delete",
  "deleteMany",
]);

export class CrossTenantAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CrossTenantAccessError";
  }
}

interface ScopableArgs {
  where?: Record<string, unknown>;
  data?: Record<string, unknown> | Record<string, unknown>[];
  create?: Record<string, unknown>;
}

/**
 * Injects `organizationId` LAST in every spread — the opposite order of the
 * documented `academyScopeWhere` hazard ("do not spread this with another
 * literal academyId key — the literal silently wins"). Here the wrapper's
 * literal must always win over caller input, never the other way around:
 * "Tenant predicates must not be overridable by caller input."
 *
 * Adding a condition can only ever narrow a `where`, never widen one, so a
 * caller-supplied composite key that already pins a different organization
 * (e.g. `{ organizationId_id: { organizationId: otherOrg, id } }`) simply
 * yields "no match" once ANDed with this — it can't be used to escape scope.
 */
/**
 * A create row expressed in Prisma's "checked" (relation-object) style —
 * `academy: { connect: { id } } }` — cannot also carry a raw `organizationId`
 * scalar: Prisma infers ONE input shape for the whole row, and mixing the
 * two throws "Argument organization is missing" at the client's own request
 * validator. Detect that style and pin the `organization` relation the same
 * way, instead of the scalar, so both styles land on the correct row.
 */
function isRelationStyleRow(row: Record<string, unknown>): boolean {
  return Object.values(row).some(
    (value) =>
      value !== null &&
      typeof value === "object" &&
      !(value instanceof Date) &&
      ("connect" in value || "create" in value || "connectOrCreate" in value),
  );
}

function pinOrganization(row: Record<string, unknown>, organizationId: string): Record<string, unknown> {
  return isRelationStyleRow(row)
    ? { ...row, organization: { connect: { id: organizationId } } }
    : { ...row, organizationId };
}

function scopeArgs(operation: string, args: ScopableArgs, organizationId: string): ScopableArgs {
  if (WHERE_SCOPED_OPERATIONS.has(operation)) {
    return { ...args, where: { ...(args.where ?? {}), organizationId } };
  }
  if (operation === "create") {
    return { ...args, data: pinOrganization(args.data as Record<string, unknown>, organizationId) };
  }
  if (operation === "createMany") {
    const data = args.data;
    return {
      ...args,
      data: Array.isArray(data)
        ? data.map((row) => pinOrganization(row, organizationId))
        : pinOrganization(data as Record<string, unknown>, organizationId),
    };
  }
  if (operation === "upsert") {
    return {
      ...args,
      where: { ...(args.where ?? {}), organizationId },
      create: pinOrganization(args.create as Record<string, unknown>, organizationId),
    };
  }
  // Nested writes/`connect` inside `data` are NOT rewritten here — this
  // wrapper only pins the top-level operation's own organizationId. Any
  // nested relation pointing at another tenant's row is caught by the
  // composite foreign keys added in the constrain migration (1b): Postgres
  // rejects the write outright (P2003) because no row exists matching
  // (organizationId, relatedId) together. See
  // `scoped-client.test.ts`'s nested-write case.
  throw new CrossTenantAccessError(
    `Operation "${operation}" is not covered by the tenant-scoped client — extend scopeArgs() before using it.`,
  );
}

/** Delegates the tenant-scoped client exposes — every other model and every raw-SQL method is unexported by this type, not merely undocumented. */
export type ScopedDb = Pick<
  PrismaClient,
  | "academy"
  | "student"
  | "classSession"
  | "attendanceRecord"
  | "promotion"
  | "promotionCredit"
  | "beltRank"
  | "promotionConfig"
  | "paymentPlan"
  | "paymentPeriod"
  | "kioskAttempt"
  | "staffAssignment"
  | "notification"
  | "$transaction"
>;

async function rawSqlBlocked(): Promise<never> {
  throw new CrossTenantAccessError(
    "Raw SQL is confined to the platform data-access module, not the tenant-scoped client.",
  );
}

/**
 * The only sanctioned way to touch tenant-owned data (spec: "a typed wrapper
 * as the only access path"). `context.organizationId` is baked into every
 * operation this returns; it cannot be overridden per-call because callers
 * never see a raw client to add a conflicting `where.organizationId` to.
 *
 * Org scope (this wrapper) and branch/academy scope are two separate filter
 * levels, per the design's own framing — this wrapper does not attempt
 * branch-level filtering itself (models spell the academy relation
 * differently — `academyId` vs `homeAcademyId` — so there is no single field
 * to inject generically). Callers combine `context.academyIds` into their
 * own `where` on top of this; org scope underneath is guaranteed either way.
 */
/** Not `any` — a concrete, honest shape for "always throws", used only to sidestep fighting Prisma's exact `$queryRaw` tagged-template overload signature. */
type BlockedRawSqlMethods = Record<string, (...args: unknown[]) => Promise<never>>;

export function getScopedDb(context: AccessContext): ScopedDb {
  const organizationId = context.organizationId;
  const extended = unscopedPrisma.$extends({
    // Blocked at runtime, not just unexported from `ScopedDb`'s type — a
    // `$allModels.$allOperations` query hook never sees these client-level
    // methods, so the type-only omission alone would be bypassable via an
    // `as any` cast. The runtime behavior (always throws) is what matters.
    client: {
      $queryRaw: rawSqlBlocked,
      $queryRawUnsafe: rawSqlBlocked,
      $executeRaw: rawSqlBlocked,
      $executeRawUnsafe: rawSqlBlocked,
    } as BlockedRawSqlMethods,
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (!model || !TENANT_SCOPED_MODELS.has(model)) {
            throw new CrossTenantAccessError(
              `Model "${model ?? "(raw)"}" is not accessible via the tenant-scoped client — use the platform data-access module.`,
            );
          }
          return query(scopeArgs(operation, args as ScopableArgs, organizationId));
        },
      },
    },
  });
  return extended as unknown as ScopedDb;
}
