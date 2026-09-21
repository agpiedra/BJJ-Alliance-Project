import { prisma } from "@/lib/prisma";
import { digestLookupSecret, generateRandomToken } from "@/lib/crypto";
import { requireEnv } from "@/lib/env";
import { slugify } from "@/lib/organizations/slug";
import { ensureDefaultPlan } from "@/lib/payments/ensure-default-plan";
import { resolveAcademyBySlug } from "@/lib/tenant/platform-lookups";
import { Prisma } from "@/generated/prisma/client";
import type { TenantContext } from "@/lib/tenant/types";

/**
 * Adding a location, as a plain function over a resolved `TenantContext` — the
 * server action does the authentication and the form parsing and calls this.
 * OWNER ONLY, and enforced here too: a context that is not the organization's
 * Owner (ADMIN) is refused, so it cannot be reached without one.
 *
 * ONE transaction: the academy with its kiosk token hash, its default payment
 * plan (the same helper approval uses) and the audit row commit together or not
 * at all — an academy with no plan is the owner lockout's cousin (nothing to
 * pick on the first payment), and an academy with no audit row is a change
 * nobody can trace.
 *
 * The plaintext kiosk token is returned exactly once and never stored: only its
 * keyed digest is, exactly as `regenerateKioskToken` does, and the audit row
 * records THAT a location was made, never the credential.
 *
 * Add-only by decision: no rename, deactivate or delete here. Those touch
 * students, schedules and payments and are proposed separately.
 */

export type LocationError = "duplicateName";

export interface CreatedLocation {
  academyId: string;
  name: string;
  slug: string;
  kioskToken: string;
}

export type LocationResult = ({ ok: true } & CreatedLocation) | { error: LocationError };

export interface NewLocationInput {
  /** Already trimmed and length-checked by the caller. */
  name: string;
  address: string | null;
}

/** Two names that differ only by case or spacing are the same name to a person choosing between locations. */
function nameKey(name: string): string {
  return name.normalize("NFC").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

/**
 * `Academy.slug` is unique across ALL organizations, so a candidate can be taken
 * by someone else's academy — hence the unscoped lookup (`resolveAcademyBySlug`),
 * the one existing place a slug is resolved without an organization. The
 * database's unique constraint is the backstop: two organizations claiming the
 * same slug at the very same instant would make one request fail (nothing
 * written, retry works) rather than corrupt anything.
 */
async function firstFreeSlug(base: string): Promise<string> {
  for (let attempt = 1; ; attempt += 1) {
    const candidate = attempt === 1 ? base : `${base}-${attempt}`;
    if (!(await resolveAcademyBySlug(candidate))) return candidate;
  }
}

export async function createLocationForOwner(context: TenantContext, input: NewLocationInput): Promise<LocationResult> {
  if (context.organizationRole !== "ADMIN") throw new Error("FORBIDDEN");
  const { organizationId } = context;

  return prisma.$transaction(async (tx) => {
    // One creation at a time per organization, so the duplicate-name check below
    // and the insert cannot interleave. Released with the transaction, so safe
    // behind a transaction pooler.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`locations:${organizationId}`}))::text AS locked`;

    const organization = await tx.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { slug: true, defaultLocale: true },
    });

    const existing = await tx.academy.findMany({ where: { organizationId }, select: { name: true } });
    if (existing.some((academy) => nameKey(academy.name) === nameKey(input.name))) return { error: "duplicateName" as const };

    const slug = await firstFreeSlug(`${organization.slug}-${slugify(input.name) || "location"}`);
    const kioskToken = generateRandomToken();

    const academy = await tx.academy.create({
      data: {
        organizationId,
        name: input.name,
        address: input.address,
        slug,
        kioskTokenHash: digestLookupSecret(kioskToken, requireEnv("CODE_PEPPER")),
      },
    });

    await ensureDefaultPlan(organizationId, academy.id, organization.defaultLocale, tx);

    await tx.auditLog.create({
      data: {
        actorId: context.actorUserId,
        organizationId,
        academyId: academy.id,
        action: "academy.create",
        entityType: "Academy",
        entityId: academy.id,
        // SQL NULL, not the JSON literal `null` — Prisma rejects a bare JS `null` for a nullable Json column.
        before: Prisma.DbNull,
        after: { name: academy.name, slug: academy.slug, address: academy.address },
      },
    });

    return { ok: true as const, academyId: academy.id, name: academy.name, slug: academy.slug, kioskToken };
  });
}
