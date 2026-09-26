/**
 * The runtime backstop Phase 1 always claimed to have (revision 23,
 * docs/MULTI_ACADEMY_AND_KIDS_BELTS.md), built for real this time: attached
 * to the BASE client (`src/lib/prisma.ts`), not to a derived object only
 * `getScopedDb()` returns. Any query against a `TENANT_SCOPED_MODEL` whose
 * arguments don't already carry a real `organizationId` — anywhere in
 * `where`, or as the write target in `data`/`create` — throws, loudly, at
 * runtime. `getScopedDb()` still works exactly as before: it builds its
 * scoped client from `unscopedPrisma` directly (see scoped-client.ts),
 * never through this guard, so there is no double-check to reconcile.
 *
 * The model list is intentionally duplicated from scoped-client.ts's
 * `TENANT_SCOPED_MODELS` rather than imported from it — this guard's whole
 * reason to exist is to be independently correct even if scoped-client.ts's
 * own wrapper is bypassed entirely, so it shouldn't share a single point of
 * failure with the mechanism it exists to backstop. Keep the two lists in
 * sync — a test in tests/unit/tenant-guard.test.ts asserts they match.
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
  // Student dues configuration (PR 2A): tenant-scoped from day one, before any writer exists.
  "DuesPolicyVersion",
  "PaymentPlanTerms",
  "StudentPlanAssignment",
  "KioskAttempt",
  "QueuedCheckIn",
  "StaffAssignment",
  "Notification",
  "OrganizationBranding",
  // MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 6 — AuditLog moved in from the
  // excluded list once it gained its first READ path (the platform admin's
  // per-organization audit trail). A write forgetting `organizationId` was
  // silent before (every AuditLog write was already inside an
  // already-scoped transaction); a READ forgetting it is not silent, it's a
  // `findMany` that returns every organization's history. See
  // `platform-lookups.ts`'s `resolveOrganizationAuditTrail` for the one
  // deliberately unscoped reader this exclusion is now narrowed to.
  "AuditLog",
]);

const WRITE_TARGET_OPERATIONS = new Set(["create", "createMany", "upsert"]);

export class UnscopedTenantQueryError extends Error {
  constructor(model: string, operation: string) {
    super(
      `Unscoped query blocked: ${model}.${operation}() carries no organizationId anywhere in its arguments. ` +
        `${model} is tenant-scoped — use getScopedDb(context).${model[0].toLowerCase()}${model.slice(1)}.${operation}(...) instead. ` +
        `If this call is genuinely platform-level (a seed, a cron iterating every organization, or the kiosk's own ` +
        `slug-to-organization resolution), import unscopedPrisma from "@/lib/prisma/unscoped" explicitly instead of ` +
        `the default guarded client — never silence this error, route around it visibly.`,
    );
    this.name = "UnscopedTenantQueryError";
  }
}

/** Recursively scans a `where`/`data`/`create` value for a real (non-empty string) `organizationId` anywhere within it — covers a direct `{organizationId}` filter, a composite key like `{organizationId_id: {organizationId, id}}`, and arbitrary `AND`/`OR`/`NOT` nesting, without needing to know each model's exact composite-key field name. */
function containsOrganizationId(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsOrganizationId);
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (key === "organizationId" && typeof nested === "string" && nested.length > 0) return true;
    if (key === "organization" && nested && typeof nested === "object") {
      // Relation-style write: `organization: { connect: { id } } }` (or `create`/`connectOrCreate`).
      const relation = nested as Record<string, unknown>;
      for (const relationValue of Object.values(relation)) {
        if (relationValue && typeof relationValue === "object" && "id" in relationValue) return true;
      }
    }
    if (nested && typeof nested === "object" && containsOrganizationId(nested)) return true;
  }
  return false;
}

function isScoped(operation: string, args: Record<string, unknown>): boolean {
  if (WRITE_TARGET_OPERATIONS.has(operation)) {
    const target = operation === "createMany" ? args.data : operation === "upsert" ? args.create : args.data;
    if (containsOrganizationId(target)) return true;
    // upsert's `where` can also carry it (e.g. a composite key including organizationId).
    if (operation === "upsert" && containsOrganizationId(args.where)) return true;
    return false;
  }
  return containsOrganizationId(args.where);
}

/**
 * A Prisma client extension (`$extends`-compatible) — attach it once, at
 * construction, to the base client. Never attach it to a client already
 * derived from `getScopedDb()`; that would just re-check work the scoping
 * extension already did correctly, for no benefit.
 */
export function tenantGuardExtension() {
  return {
    name: "tenant-guard",
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }: {
          model?: string;
          operation: string;
          args: Record<string, unknown>;
          query: (args: Record<string, unknown>) => Promise<unknown>;
        }) {
          if (model && TENANT_SCOPED_MODELS.has(model) && !isScoped(operation, args ?? {})) {
            throw new UnscopedTenantQueryError(model, operation);
          }
          return query(args);
        },
      },
    },
  };
}
