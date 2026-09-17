import type { OrganizationStatus, Role } from "@/generated/prisma/client";

export type MembershipRole = Role;

/**
 * A single request's fully-resolved, DB-verified tenant identity.
 *
 * Never construct this by hand outside `context.ts` — every field here is
 * the result of a membership + organization-status check, not a claim from a
 * cookie or JWT. MULTI_ACADEMY_AND_KIDS_BELTS.md Appendix C decision 4 /
 * proposal points 1 and 6.
 */
export interface TenantContext {
  kind: "tenant";
  actorUserId: string;
  organizationId: string;
  organizationRole: MembershipRole;
  /** "ALL" only for ADMIN — resolved centrally here, never re-derived at a call site. */
  academyIds: string[] | "ALL";
  /**
   * Non-null iff `organizationRole === "STUDENT"`. A STUDENT's own linked
   * `Student` row, if one exists — never set from "a Student row exists for
   * this user" alone, since staff members can also have a linked Student
   * record from their own training and must still see the full roster.
   */
  selfStudentId: string | null;
  impersonation?: { asSuperAdminUserId: string; startedAt: Date; readOnly: boolean };
}

/** Tenant context for cron/job dispatch — has no acting user, only a job identity. */
export interface SystemJobContext {
  kind: "system-job";
  organizationId: string;
  jobName: string;
}

/**
 * The kiosk's own access identity — 1f-3. A kiosk request has no session and
 * no acting user; its authority comes entirely from a verified device kiosk
 * token, which resolves to exactly one academy and, through it, exactly one
 * organization. Deliberately a distinct union member rather than a
 * "deliberate exception" carve-out elsewhere: every function that accepts
 * `AccessContext` generically (`getScopedDb`, `tenantScopeWhere`'s
 * successor) must now say what a kiosk gets, and `tsc` enforces that no
 * caller silently forgets to.
 */
export interface KioskContext {
  kind: "kiosk";
  organizationId: string;
  academyId: string;
}

export type AccessContext = TenantContext | SystemJobContext | KioskContext;

/**
 * Four distinct failure shapes, deliberately never collapsed into each
 * other (the bug this type closes): `UNAUTHENTICATED` (no session at all)
 * and `NO_MEMBERSHIP` (a real, signed-in user with zero active
 * memberships) look identical from the outside if conflated — both used to
 * redirect to /login — but they are different facts about the world and
 * `requireTenantContext` now sends them to different pages.
 * `NEEDS_ORGANIZATION_SELECTION` is likewise its own state: an
 * authenticated user with 2+ active memberships and no resolved selector
 * yet, never silently defaulted to one of them (Appendix C decision 4,
 * point 6).
 */
export type TenantContextResult =
  | { status: "OK"; context: TenantContext }
  | { status: "UNAUTHENTICATED" }
  | { status: "NO_MEMBERSHIP" }
  | { status: "NEEDS_ORGANIZATION_SELECTION" }
  | { status: "ORG_NOT_ACTIVE"; organizationStatus: OrganizationStatus };
