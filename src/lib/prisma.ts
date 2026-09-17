import { unscopedPrisma } from "@/lib/prisma/unscoped";
import { tenantGuardExtension } from "@/lib/tenant/tenant-guard";

/**
 * The default, guarded client — revision 23
 * (docs/MULTI_ACADEMY_AND_KIDS_BELTS.md): this used to be the raw client,
 * which made the obvious default import the unsafe one. Any query against a
 * tenant-scoped model with no `organizationId` anywhere in its arguments
 * throws (`tenant-guard.ts`) instead of silently returning every
 * organization's rows. Platform-level models (`Organization`, `User`,
 * `OrganizationMembership`, `AuditLog`, `PasswordResetToken`) pass through
 * untouched — they were never in the guarded set. `getScopedDb()` does NOT
 * build on this client (see scoped-client.ts) — it extends `unscopedPrisma`
 * directly, so a correctly-scoped query never pays for a redundant check.
 */
export const prisma = unscopedPrisma.$extends(tenantGuardExtension());
