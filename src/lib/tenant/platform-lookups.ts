import { unscopedPrisma } from "@/lib/prisma/unscoped";
import { deriveInitials, resolvePrimaryTheme, resolveSidebarTheme, type ResolvedPrimaryTheme, type ResolvedSidebarTheme } from "@/lib/theme";
import { resolveInvoiceState, isUnreviewed } from "@/lib/billing/deadline";
import type { Academy, OrganizationStatus, Prisma } from "@/generated/prisma/client";

/**
 * The full set of genuinely platform-level Academy lookups — every one of
 * these resolves a tenant's IDENTITY from a public, pre-auth signal (a kiosk
 * device's slug, a cron job's own id, a hardcoded signup allowlist), which is
 * exactly the shape that can never itself be organization-scoped: a query
 * cannot be filtered by the organization it exists to discover.
 *
 * Isolating `unscopedPrisma` to this one small module (rather than
 * allowlisting every route/page that happened to need one of these) is
 * deliberate. The previous allowlist named 8 individual route files, several
 * of them the exact unauthenticated, pre-tenant surfaces that produced every
 * real leak in this codebase (revision 23/24) — a lint-blessed
 * general-purpose unscoped client sitting directly in `signup/page.tsx`
 * meant the *next* edit to that exact file got no warning at all, which is
 * the guard going quiet precisely where it is needed most. Every other
 * caller now imports a function that does ONE thing, never a client that
 * can do anything.
 */

/**
 * Resolves an Academy by its public URL slug (kiosk devices, self-signup).
 * `null` if no row matches — callers decide what "not found" means for
 * their own response shape (a generic 404, an indistinguishable
 * "invalid_token", etc.), so this never throws on a miss.
 */
export async function resolveAcademyBySlug(slug: string): Promise<Academy | null> {
  return unscopedPrisma.academy.findUnique({ where: { slug } });
}

/**
 * Resolves an Academy's own id/name/organizationId from its id — for
 * callers that already know WHICH academy (a cron's own per-academy
 * iteration, a notification event keyed on `academyId`) but not yet which
 * organization it belongs to.
 *
 * Named `...OrThrow`, matching Prisma's own convention this wraps
 * (`findUniqueOrThrow`) — deliberately NOT the same null-on-miss contract
 * as `resolveAcademyBySlug` above. Both take an id-shaped input and look
 * similar at the call site, so the failure behavior has to be visible in
 * the name, not something a caller has to go read the implementation to
 * discover. Throws if the id doesn't name a real row: every current
 * caller already knows this id came from its own trusted source (a
 * `ClassSession`/`AttendanceRecord` FK, a cron's own just-fetched list),
 * so a miss here means real data corruption, not a value worth handling
 * gracefully.
 */
export async function resolveAcademyByIdOrThrow(
  academyId: string,
): Promise<Pick<Academy, "id" | "name" | "organizationId">> {
  return unscopedPrisma.academy.findUniqueOrThrow({
    where: { id: academyId },
    select: { id: true, name: true, organizationId: true },
  });
}

export interface SignupOrganization {
  id: string;
  name: string;
  academies: Array<{ slug: string; name: string }>;
}

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 5 — replaces the old
 * `listSignupAcademies`'s hardcoded `z.enum(["escazu", "escalante"])`
 * stopgap. That restriction existed because signup was public and
 * pre-tenant — its unrestricted predecessor leaked every academy across
 * every organization to anonymous visitors (revision 23). The real fix
 * isn't a bigger allowlist, it's the same one login uses: the organization
 * is now explicit, named by `/o/[orgSlug]/signup`'s own URL segment, so the
 * academy list this returns is genuinely scoped by it — safe because the
 * org was deliberately identified, not because of a hardcoded list.
 *
 * `null` for an unknown OR non-ACTIVE organization slug — unlike login,
 * signup has no safe neutral fallback to show (there is nothing generic to
 * sign up FOR), so the caller renders a plain 404, same as any other
 * unmatched route.
 */
export async function resolveOrganizationForSignup(orgSlug: string): Promise<SignupOrganization | null> {
  const organization = await unscopedPrisma.organization.findUnique({
    where: { slug: orgSlug },
    select: { id: true, name: true, status: true },
  });
  if (!organization || organization.status !== "ACTIVE") return null;

  const academies = await unscopedPrisma.academy.findMany({
    where: { organizationId: organization.id, active: true },
    orderBy: { name: "asc" },
    select: { slug: true, name: true },
  });

  return { id: organization.id, name: organization.name, academies };
}

/**
 * Every active Academy's id, for the weekly-digest cron's own per-academy
 * dispatch loop — the one legitimate "iterate every organization on the
 * platform" job in this codebase.
 */
export async function listActiveAcademyIdsForDigest(): Promise<string[]> {
  const academies = await unscopedPrisma.academy.findMany({ where: { active: true }, select: { id: true } });
  return academies.map((academy) => academy.id);
}

export interface OrganizationAuditEntry {
  id: string;
  actorEmail: string | null;
  action: string;
  entityType: string;
  entityId: string;
  before: unknown;
  after: unknown;
  createdAt: Date;
}

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 6 — the ONE deliberately cross-
 * tenant reader of `AuditLog`, now that it's a `TENANT_SCOPED_MODEL`
 * (tenant-guard.ts's own doc comment). A platform admin viewing
 * `/platform/organizations/[id]` needs a specific TARGET organization's
 * trail, which is never the admin's own tenant context (a SUPER_ADMIN may
 * have no organization membership at all) — `getScopedDb` cannot express
 * "read this OTHER organization," by design, so this goes through
 * `unscopedPrisma` explicitly, named and greppable, exactly the shape the
 * allowlist collapse (revision 23) established for every other genuinely
 * platform-level read in this file.
 *
 * Every caller of this function MUST itself be gated by `requireSuperAdmin`
 * first — this function has no gate of its own, the same way
 * `resolveAcademyBySlug` above trusts its own callers' gating.
 */
export async function resolveOrganizationAuditTrail(
  organizationId: string,
  limit = 100,
): Promise<OrganizationAuditEntry[]> {
  const entries = await unscopedPrisma.auditLog.findMany({
    where: { organizationId },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      action: true,
      entityType: true,
      entityId: true,
      before: true,
      after: true,
      createdAt: true,
      actor: { select: { email: true } },
    },
  });
  return entries.map((entry) => ({
    id: entry.id,
    actorEmail: entry.actor?.email ?? null,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    before: entry.before,
    after: entry.after,
    createdAt: entry.createdAt,
  }));
}

export interface OrganizationLoginBranding {
  displayName: string;
  initials: string;
  logoUrl: string | null;
  primary: ResolvedPrimaryTheme;
  sidebar: ResolvedSidebarTheme;
}

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 5 — real per-org login branding,
 * replacing Phase 4's `resolveSingleOrganizationBranding` stopgap outright
 * (deleted, not deprecated, exactly as promised when that stopgap was
 * built: "it should still be deleted outright once Phase 5's real per-org
 * login routing exists").
 *
 * `null` for an unknown slug OR a non-ACTIVE organization — and
 * deliberately the SAME `null` for both. An anonymous, pre-auth visitor is
 * "not yet a member" by this project's own settled disclosure rule
 * ("disclose to members, never to non-members" — see the Global rules
 * above), so a PENDING/SUSPENDED/CANCELLED organization's branding, or
 * even the fact that a slug does or doesn't correspond to a real
 * organization, is never shown pre-auth. The caller (`/o/[orgSlug]/login`)
 * renders the exact same neutral, unbranded login for all three cases. A
 * real member who actually signs in still reaches `/organization-unavailable`
 * via the existing `requireTenantContext` flow, which already discloses the
 * honest reason correctly — that path is untouched here.
 *
 * IMPORTANT: `orgSlug` is a pre-auth DISPLAY signal only, never an
 * authorization input. It decides what's SHOWN before credentials are
 * submitted; it must never be used to scope, gate, or influence which
 * organization a `signIn()` call actually authenticates into — that is
 * resolved entirely from the verified user identity afterward, exactly as
 * it is for bare `/login`.
 *
 * Duplicates get-branding.ts's own composition (resolve primary, feed its
 * background into the sidebar as the active-color default) rather than
 * sharing it — deliberately: that function takes a tenant `AccessContext`
 * and reads through `getScopedDb`, which requires exactly the tenant
 * identity this function is being asked to find. There is no context to
 * scope by yet, which is what makes this a platform-lookups.ts function at
 * all, same as every other one in this file.
 */
export async function resolveOrganizationLoginBranding(orgSlug: string): Promise<OrganizationLoginBranding | null> {
  const organization = await unscopedPrisma.organization.findUnique({
    where: { slug: orgSlug },
    select: { id: true, name: true, status: true },
  });
  if (!organization || organization.status !== "ACTIVE") return null;

  const row = await unscopedPrisma.organizationBranding.findUnique({ where: { organizationId: organization.id } });

  const displayName = row?.displayName || organization.name;
  const primary = resolvePrimaryTheme(row?.primaryColor ?? "#FACC15");

  return {
    displayName,
    initials: deriveInitials(displayName),
    logoUrl: row?.logoUrl ?? null,
    primary,
    sidebar: resolveSidebarTheme({
      background: row?.sidebarBackground ?? "#111827",
      foreground: row?.sidebarForeground,
      activeBackground: row?.sidebarActiveBackground,
      activeForeground: row?.sidebarActiveForeground,
      activeBackgroundDefault: primary.background,
      border: row?.sidebarBorder,
    }),
  };
}

// ---------------------------------------------------------------------------
// MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 6 — the platform admin panel's own
// reads. Every function below is gated by nothing of its own; every caller
// MUST already be behind `requireSuperAdmin`/`resolveSuperAdminActionContext`
// (platform/layout.tsx and the platform route files' own top-level gate) —
// same trust boundary as every other function in this file. Kept in THIS
// file, not a second one, per eslint.config.mjs's own allowlist comment:
// "every genuinely platform-level operation was extracted into named,
// single-purpose functions in src/lib/tenant/platform-lookups.ts... so the
// bracket-as-character-class glob bug that hid three entries from this list
// structurally cannot recur." A second file just reopens that exact hole.
// ---------------------------------------------------------------------------

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export interface PlatformOrganizationSummary {
  id: string;
  slug: string;
  name: string;
  status: OrganizationStatus;
  country: string | null;
  city: string | null;
  logoUrl: string | null;
  branchCount: number;
  studentCount: number;
  activeStudentCount: number;
  attendanceLast30Days: number;
  createdAt: Date;
  approvedAt: Date | null;
  lastActivityAt: Date | null;
  /** MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 6 billing — the most urgent OPEN
   * invoice's derived state (GRACE_EXPIRED outranks DUE), or `null` when
   * every invoice is CURRENT/paid/voided/nonexistent. `billingUnreviewed`
   * is true only when that invoice is GRACE_EXPIRED and not yet
   * acknowledged for its current expiration episode — see deadline.ts's
   * own `isUnreviewed`. */
  billingState: "DUE" | "GRACE_EXPIRED" | null;
  billingUnreviewed: boolean;
}

export interface PlatformOrganizationFilters {
  status?: OrganizationStatus;
  country?: string;
  search?: string;
  /** "DUE" / "GRACE_EXPIRED" / "unreviewed" (doc: "filters for DUE /
   * GRACE_EXPIRED / acknowledged, so the overdue set is one click away") —
   * applied after the derived billing state is computed, since it can't be
   * expressed as a Prisma `where` clause (it depends on a per-organization
   * calculation, not a stored column). */
  billing?: "DUE" | "GRACE_EXPIRED" | "unreviewed";
}

/**
 * `/platform/organizations` — list, filtered by status/country and searched
 * by name/slug/contact (doc: "Filters by status and country; search by
 * name/slug/contact"). Aggregates (`branchCount`, `studentCount`, etc.) are
 * computed via `groupBy` across the whole matching set in three queries,
 * not one query per organization.
 */
export async function listOrganizationsForPlatformAdmin(
  filters: PlatformOrganizationFilters = {},
): Promise<PlatformOrganizationSummary[]> {
  const where: Prisma.OrganizationWhereInput = {};
  if (filters.status) where.status = filters.status;
  if (filters.country) where.country = filters.country;
  if (filters.search) {
    const search = filters.search;
    where.OR = [
      { name: { contains: search, mode: "insensitive" } },
      { slug: { contains: search, mode: "insensitive" } },
      { contactEmail: { contains: search, mode: "insensitive" } },
      { contactName: { contains: search, mode: "insensitive" } },
    ];
  }

  const organizations = await unscopedPrisma.organization.findMany({
    where,
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      slug: true,
      name: true,
      status: true,
      country: true,
      city: true,
      timezone: true,
      createdAt: true,
      approvedAt: true,
      branding: { select: { logoUrl: true } },
      _count: { select: { academies: true, students: true } },
      invoices: {
        where: { paidAt: null, voidedAt: null },
        select: { dueOn: true, graceDaysApplied: true, graceExtensionDays: true, paidAt: true, voidedAt: true, reviewAcknowledgedForFlaggedOn: true },
      },
    },
  });

  const organizationIds = organizations.map((organization) => organization.id);
  const windowStart = new Date(Date.now() - THIRTY_DAYS_MS);

  const [activeStudentGroups, attendanceGroups, lastActivityGroups] = await Promise.all([
    unscopedPrisma.student.groupBy({
      by: ["organizationId"],
      where: { organizationId: { in: organizationIds }, status: "ACTIVE" },
      _count: { _all: true },
    }),
    unscopedPrisma.attendanceRecord.groupBy({
      by: ["organizationId"],
      where: { organizationId: { in: organizationIds }, occurredAt: { gte: windowStart } },
      _count: { _all: true },
    }),
    unscopedPrisma.attendanceRecord.groupBy({
      by: ["organizationId"],
      where: { organizationId: { in: organizationIds } },
      _max: { occurredAt: true },
    }),
  ]);

  const activeStudentsByOrg = new Map(activeStudentGroups.map((g) => [g.organizationId, g._count._all]));
  const attendanceByOrg = new Map(attendanceGroups.map((g) => [g.organizationId, g._count._all]));
  const lastActivityByOrg = new Map(lastActivityGroups.map((g) => [g.organizationId, g._max.occurredAt]));

  const summaries = organizations.map((organization) => {
    let billingState: "DUE" | "GRACE_EXPIRED" | null = null;
    let billingUnreviewed = false;
    for (const invoice of organization.invoices) {
      const state = resolveInvoiceState(invoice, organization.timezone);
      if (state === "CURRENT") continue;
      if (!billingState || (state === "GRACE_EXPIRED" && billingState === "DUE")) {
        billingState = state;
        billingUnreviewed = state === "GRACE_EXPIRED" && isUnreviewed(invoice, organization.timezone);
      }
    }

    return {
      id: organization.id,
      slug: organization.slug,
      name: organization.name,
      status: organization.status,
      country: organization.country,
      city: organization.city,
      logoUrl: organization.branding?.logoUrl ?? null,
      branchCount: organization._count.academies,
      studentCount: organization._count.students,
      activeStudentCount: activeStudentsByOrg.get(organization.id) ?? 0,
      attendanceLast30Days: attendanceByOrg.get(organization.id) ?? 0,
      createdAt: organization.createdAt,
      approvedAt: organization.approvedAt,
      lastActivityAt: lastActivityByOrg.get(organization.id) ?? null,
      billingState,
      billingUnreviewed,
    };
  });

  if (!filters.billing) return summaries;
  if (filters.billing === "unreviewed") return summaries.filter((s) => s.billingUnreviewed);
  return summaries.filter((s) => s.billingState === filters.billing);
}

export interface PlatformOverview {
  countsByStatus: Record<OrganizationStatus, number>;
  totalStudents: number;
  newOrganizationsThisMonth: number;
  pendingCount: number;
}

/** `/platform` — the overview page's own numbers. */
export async function resolvePlatformOverview(): Promise<PlatformOverview> {
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

  const [statusGroups, totalStudents, newOrganizationsThisMonth, pendingCount] = await Promise.all([
    unscopedPrisma.organization.groupBy({ by: ["status"], _count: { _all: true } }),
    unscopedPrisma.student.count(),
    unscopedPrisma.organization.count({ where: { createdAt: { gte: startOfMonth } } }),
    unscopedPrisma.organization.count({ where: { status: "PENDING" } }),
  ]);

  const countsByStatus: Record<OrganizationStatus, number> = { PENDING: 0, ACTIVE: 0, SUSPENDED: 0, CANCELLED: 0 };
  for (const group of statusGroups) {
    countsByStatus[group.status] = group._count._all;
  }

  return { countsByStatus, totalStudents, newOrganizationsThisMonth, pendingCount };
}

export interface PlatformWeeklyAttendancePoint {
  weekStart: string;
  count: number;
}

/**
 * Platform-wide 8-week attendance trend for the `/platform` overview,
 * reusing `WeeklyAttendanceChart` (dashboard/weekly-attendance-chart.tsx)
 * as-is — same component, same data shape, just summed across every
 * organization instead of one. Mirrors `getWeeklyAttendanceTrend`'s own
 * week-bucketing logic (analytics/retention.ts), deliberately not shared
 * with it: that function is bound to a single `TenantContext`/`getScopedDb`
 * by design, and this one is bound to none, on purpose.
 */
export async function getPlatformWeeklyAttendanceTrend(weeks: number): Promise<PlatformWeeklyAttendancePoint[]> {
  const now = new Date();
  const from = new Date(now.getTime() - weeks * 7 * 24 * 60 * 60 * 1000);

  const attendances = await unscopedPrisma.attendanceRecord.findMany({
    where: { type: "CHECKIN", occurredAt: { gte: from, lte: now } },
    select: { occurredAt: true },
  });

  const countByWeekStart = new Map<string, number>();
  for (const record of attendances) {
    const weekStart = new Date(record.occurredAt);
    const day = weekStart.getUTCDay();
    const diff = (day + 6) % 7; // Monday-start week, matching retention.ts's convention
    weekStart.setUTCDate(weekStart.getUTCDate() - diff);
    weekStart.setUTCHours(0, 0, 0, 0);
    const key = weekStart.toISOString().slice(0, 10);
    countByWeekStart.set(key, (countByWeekStart.get(key) ?? 0) + 1);
  }

  return [...countByWeekStart.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([weekStart, count]) => ({ weekStart, count }));
}

export interface PendingOrganizationSummary {
  id: string;
  name: string;
  slug: string;
  country: string | null;
  city: string | null;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  studentCountBand: string | null;
  referralSource: string | null;
  createdAt: Date;
}

/** `/platform/organizations/pending` — the approval queue, oldest first (first come, first reviewed). */
export async function listPendingOrganizations(): Promise<PendingOrganizationSummary[]> {
  return unscopedPrisma.organization.findMany({
    where: { status: "PENDING" },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      name: true,
      slug: true,
      country: true,
      city: true,
      contactName: true,
      contactEmail: true,
      contactPhone: true,
      studentCountBand: true,
      referralSource: true,
      createdAt: true,
    },
  });
}

/** `/platform/organizations/[id]` — the full detail read, everything the doc's page needs in one query plus the audit trail (fetched separately via `resolveOrganizationAuditTrail`, above). `null` on a miss — the page itself calls `notFound()`. */
export async function resolveOrganizationDetailForPlatformAdmin(organizationId: string) {
  return unscopedPrisma.organization.findUnique({
    where: { id: organizationId },
    include: {
      branding: true,
      academies: { orderBy: { name: "asc" } },
      promotionConfigs: true,
      memberships: { include: { user: { select: { email: true, active: true } } } },
      // MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 6 billing — this is the
      // platform admin's OWN detail page, the one surface `graceDays`/
      // `graceDaysApplied`/`graceExtensionDays` are explicitly allowed on
      // (SUPER_ADMIN-only). The director-facing rule ("never a bare
      // findUnique whose whole row is handed to a component") governs
      // director surfaces, not this one — see billing/banner.ts for the
      // actual director-facing DTO that rule applies to.
      invoices: { orderBy: { dueOn: "desc" } },
    },
  });
}

export interface PlatformAdminUser {
  id: string;
  email: string;
  active: boolean;
}

/** `/platform/admins` — every current `isSuperAdmin` holder. */
export async function listPlatformAdmins(): Promise<PlatformAdminUser[]> {
  return unscopedPrisma.user.findMany({
    where: { isSuperAdmin: true },
    select: { id: true, email: true, active: true },
    orderBy: { email: "asc" },
  });
}

/**
 * Grant/revoke both write an `AuditLog` row with `organizationId: null` — a
 * genuinely platform-level action with no organization to scope by, the
 * exact case `AuditLog.organizationId`'s own schema doc comment
 * anticipated. `containsOrganizationId()` (tenant-guard.ts) requires a real
 * non-empty STRING, and a literal `null` does not satisfy that check — so
 * this transaction goes through `unscopedPrisma`, not the guarded `prisma`
 * export, exactly the "genuinely platform-level, route around it visibly"
 * case the guard's own error message names. `admins/actions.ts` keeps the
 * business-logic checks (self-revoke, last-admin, existence) — this
 * function is only the write.
 */
export async function grantSuperAdminFlag(actorUserId: string, targetUserId: string): Promise<void> {
  await unscopedPrisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: targetUserId }, data: { isSuperAdmin: true } });
    await tx.auditLog.create({
      data: {
        actorId: actorUserId,
        organizationId: null,
        action: "user.superAdminGranted",
        entityType: "User",
        entityId: targetUserId,
        before: { isSuperAdmin: false },
        after: { isSuperAdmin: true },
      },
    });
  });
}

/** See `grantSuperAdminFlag`'s own doc comment — same reasoning, reverse direction. */
export async function revokeSuperAdminFlag(actorUserId: string, targetUserId: string): Promise<void> {
  await unscopedPrisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: targetUserId }, data: { isSuperAdmin: false } });
    await tx.auditLog.create({
      data: {
        actorId: actorUserId,
        organizationId: null,
        action: "user.superAdminRevoked",
        entityType: "User",
        entityId: targetUserId,
        before: { isSuperAdmin: true },
        after: { isSuperAdmin: false },
      },
    });
  });
}
