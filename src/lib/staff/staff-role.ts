/**
 * The roles staff management deals in. Deliberately its OWN file with zero
 * imports: the staff page's forms are Client Components that need these values,
 * and `staff-service.ts` imports `@/lib/prisma` (Node-only) — importing them
 * from there would pull Prisma's runtime into the client bundle. Same reasoning
 * as `payments/custom-promo-plan-name.ts`.
 *
 * `STUDENT` is a membership role too, but students are not staff and are never
 * managed on the staff page.
 */
export const STAFF_ROLES = ["ADMIN", "DIRECTOR", "INSTRUCTOR"] as const;
export type StaffMembershipRole = (typeof STAFF_ROLES)[number];

export function isStaffRole(role: string): role is StaffMembershipRole {
  return (STAFF_ROLES as readonly string[]).includes(role);
}
