"use server";

import { z } from "zod";
import { headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import { ADULT_RANKS, KIDS_RANKS, KIDS_BAR } from "@/lib/organizations/default-belt-ranks";
import { sendTransactionalEmail } from "@/lib/email/send-transactional-email";
import type { ActionState } from "@/lib/action-state";

/**
 * No real terms-of-service document exists yet — see Organization.termsVersion's
 * own schema doc comment. This records acceptance of whatever this form
 * currently shows, not a real legal record. Bump this string (and the form
 * copy) the day a real document replaces it.
 */
const TERMS_VERSION = "2026-draft-no-real-document";

const REGISTRATION_WINDOW_MINUTES = 60;
const REGISTRATION_MAX_PER_IP = 5;
const REGISTRATION_MAX_PER_EMAIL = 3;

/**
 * `z.strictObject`, not `z.object` — the doc's own acceptance criterion
 * ("the public form accepts no file upload and no color input; a request
 * that posts one is rejected") was previously ticked on Zod's DEFAULT
 * behavior of silently stripping unrecognized keys, which is an accident of
 * the library's default, not an enforced guarantee — the same "looked
 * correct, checked nothing" shape this project has now found five times.
 * `z.strictObject` makes an unrecognized key (a crafted `logo` or
 * `primaryColor` field, for instance) an actual validation failure —
 * `error: "invalid"` — not a silently-ignored no-op. See the test asserting
 * this directly in tests/integration/organization-registration.test.ts.
 */
const registrationSchema = z.strictObject({
  organizationName: z.string().min(1).max(200),
  desiredSlug: z
    .string()
    .min(2)
    .max(60)
    .regex(/^[a-z0-9-]+$/, "slugFormat"),
  country: z.string().min(1).max(100),
  city: z.string().min(1).max(100),
  contactName: z.string().min(1).max(200),
  contactEmail: z.string().email(),
  contactPhone: z.string().min(1).max(50),
  studentCountBand: z.string().min(1).max(50),
  referralSource: z.string().max(200).optional(),
  preferredLocale: z.enum(["es", "en"]),
  termsAccepted: z.literal("on", { message: "termsRequired" }),
  // Honeypot — real visitors never see or fill this field (hidden via CSS
  // in the form, never `type="hidden"`, which some bots skip). Checked
  // AFTER parsing, never as a zod failure: a filled honeypot gets the exact
  // same success response a real submission gets, silently discarding it —
  // never disclosing to whoever's probing that they were caught.
  website: z.string().optional(),
});

export type RegistrationState = ActionState & { slugTaken?: boolean };

/**
 * `ip` is read from `x-forwarded-for` for rate-limiting purposes only —
 * same honest limitation the kiosk's own rate limiter documents for this
 * exact header (src/lib/kiosk/rate-limit.ts): it can be forged or rotated
 * per request by the caller, so this is a best-effort deterrent against
 * casual abuse, never a hard security boundary. The kiosk's own rate
 * limiter uses a cryptographically-verified token as its real key instead;
 * this form has no equivalent pre-submission secret, so IP+email (per the
 * doc's own "DB-backed counter is fine") is the best available signal.
 *
 * `headers()` throws ("called outside a request scope") when this function
 * runs anywhere other than a genuine Next.js request — found directly by
 * running registerOrganization() from a plain integration test, the same
 * class of Next-runtime-only-API limitation get-branding.ts's own
 * unstable_cache discovery already established for this codebase. Falling
 * back to a shared "unknown" bucket on that failure is consistent with,
 * not a weakening of, this signal's own already-documented best-effort
 * nature — it was never a hard security boundary either way.
 */
async function resolveClientIp(): Promise<string> {
  try {
    const headerList = await headers();
    const forwardedFor = headerList.get("x-forwarded-for");
    return forwardedFor?.split(",")[0]?.trim() || "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Deliberately its own table, not AuditLog — see RegistrationAttempt's own
 * schema doc comment for why (AuditLog.entityType/entityId are non-nullable
 * and must reference a real entity; a rate-limited attempt is the common
 * case that creates nothing at all, and a transient high-volume counter has
 * a different purpose and retention shape than a permanent action record).
 *
 * The email check ALWAYS runs. The IP check is skipped entirely when `ip`
 * is the "unknown" sentinel `resolveClientIp()` returns whenever it has no
 * real signal (a host that doesn't set `x-forwarded-for`, or `headers()`
 * throwing outside a real request). Every caller with no real IP shares
 * that one literal string — counting it as a real IP would mean three
 * requests from anyone on such a host locks out every OTHER legitimate
 * registration attempt on the entire platform, on the one form that brings
 * in customers. That is a worse failure than under-limiting a case this
 * signal was already too weak to police (documented above: forgeable,
 * rotatable, best-effort). Failing open on the IP axis specifically here —
 * relying on the still-enforced, per-email limit — is deliberate, not an
 * oversight.
 */
async function isRegistrationRateLimited(ip: string, email: string): Promise<boolean> {
  const windowStart = new Date(Date.now() - REGISTRATION_WINDOW_MINUTES * 60 * 1000);
  const byEmail = await prisma.registrationAttempt.count({ where: { email, createdAt: { gte: windowStart } } });
  if (byEmail >= REGISTRATION_MAX_PER_EMAIL) return true;

  if (ip === "unknown") return false;

  const byIp = await prisma.registrationAttempt.count({ where: { ip, createdAt: { gte: windowStart } } });
  return byIp >= REGISTRATION_MAX_PER_IP;
}

/**
 * The form's live availability check as the director types a slug — never
 * the final authority. The transaction below re-checks uniqueness itself
 * (the database's own @unique constraint is what actually prevents a race
 * between this check and a real submission), so a stale "available"
 * response here can never create a duplicate. `Organization` is not a
 * tenant-scoped model (it IS the tenant), so the plain guarded `prisma`
 * client needs no special handling here.
 */
export async function checkSlugAvailability(slug: string): Promise<{ available: boolean }> {
  if (!/^[a-z0-9-]{2,60}$/.test(slug)) return { available: false };
  const existing = await prisma.organization.findUnique({ where: { slug }, select: { id: true } });
  return { available: !existing };
}

export async function registerOrganization(_prevState: RegistrationState, formData: FormData): Promise<RegistrationState> {
  const raw = Object.fromEntries(formData.entries());
  const parsed = registrationSchema.safeParse(raw);
  if (!parsed.success) {
    return { error: "invalid", fieldErrors: parsed.error.flatten().fieldErrors };
  }
  const data = parsed.data;

  // Honeypot — see the schema field's own comment. Silent success, nothing written.
  if (data.website) {
    return { ok: true };
  }

  const ip = await resolveClientIp();

  // The attempt is recorded regardless of outcome — including this one, if
  // it turns out to be the one that trips the limit below. A counter that
  // only counts successes could never actually cap a retry storm.
  await prisma.registrationAttempt.create({ data: { ip, email: data.contactEmail } });

  if (await isRegistrationRateLimited(ip, data.contactEmail)) {
    return { error: "rateLimited" };
  }

  const existingSlug = await prisma.organization.findUnique({
    where: { slug: data.desiredSlug },
    select: { id: true },
  });
  if (existingSlug) {
    return { error: "slugTaken", slugTaken: true, fieldErrors: { desiredSlug: ["slugTaken"] } };
  }

  const existingContactEmail = await prisma.organization.findFirst({
    where: { contactEmail: data.contactEmail, status: { in: ["PENDING", "ACTIVE"] } },
    select: { id: true },
  });
  if (existingContactEmail) {
    // Handled gracefully — the doc's own acceptance criterion ("duplicate
    // contact emails... handled without a 500") — not a security-sensitive
    // disclosure: this is a public form telling the submitter their own
    // email is already registered, the same class of message /signup's
    // emailTaken shows.
    return { error: "emailAlreadyRegistered", fieldErrors: { contactEmail: ["emailAlreadyRegistered"] } };
  }

  const organizationId = await prisma.$transaction(async (tx) => {
    const organization = await tx.organization.create({
      data: {
        slug: data.desiredSlug,
        name: data.organizationName,
        status: "PENDING",
        defaultLocale: data.preferredLocale,
        country: data.country,
        city: data.city,
        contactName: data.contactName,
        contactEmail: data.contactEmail,
        contactPhone: data.contactPhone,
        studentCountBand: data.studentCountBand,
        referralSource: data.referralSource || null,
        termsVersion: TERMS_VERSION,
        termsAcceptedAt: new Date(),
      },
    });

    // Branding defaults — same shape as the transactional create documented
    // on OrganizationBranding's own schema doc comment ("created in the
    // same transaction as the Organization").
    await tx.organizationBranding.create({ data: { organizationId: organization.id } });

    // Both seeded rank catalogs, from the same single source of truth
    // Alliance's own seed uses (src/lib/organizations/default-belt-ranks.ts)
    // — see that module's own doc comment for why there is exactly one copy
    // of this data.
    await tx.beltRank.createMany({
      data: ADULT_RANKS.map((rank) => ({
        organizationId: organization.id,
        track: "ADULT" as const,
        code: rank.code,
        labelEs: rank.labelEs,
        labelEn: rank.labelEn,
        order: rank.order,
        maxStripes: rank.maxStripes,
        attendancesPerStripe: rank.attendancesPerStripe,
        attendancesForExam: rank.attendancesForExam,
        isTerminal: rank.isTerminal,
        primaryColor: rank.primaryColor,
        barColor: rank.barColor,
        stripeColors: Array.from({ length: rank.maxStripes }, () => "#FFFFFF"),
        visibleStripeSlots: 4,
      })),
    });
    await tx.promotionConfig.create({
      data: { organizationId: organization.id, track: "ADULT", mode: "ATTENDANCE", requiresCoachApproval: true },
    });

    await tx.beltRank.createMany({
      data: KIDS_RANKS.map((rank) => ({
        organizationId: organization.id,
        track: "KIDS" as const,
        code: rank.code,
        labelEs: rank.labelEs,
        labelEn: rank.labelEn,
        order: rank.order,
        maxStripes: rank.maxStripes,
        attendancesPerStripe: 10,
        attendancesForExam: 10,
        isTerminal: rank.isTerminal,
        primaryColor: rank.primaryColor,
        centerStripeColor: rank.centerStripeColor ?? null,
        barColor: KIDS_BAR,
        stripeColors: rank.stripeColors,
        visibleStripeSlots: 4,
      })),
    });
    await tx.promotionConfig.create({
      data: { organizationId: organization.id, track: "KIDS", mode: "ATTENDANCE", requiresCoachApproval: true },
    });

    return organization.id;
  });

  // Sent AFTER the transaction commits, per the doc's own "email failure
  // does not roll back signup" — the organization/branding/ranks above are
  // already durably written regardless of whether this send succeeds.
  const emailResult = await sendTransactionalEmail(data.contactEmail, `${data.organizationName} — registration received`, [
    `Thanks for registering ${data.organizationName}.`,
    "Your request is under review. We'll email you again once it's approved.",
  ]);
  if (!emailResult.success) {
    console.error("[register-academy] confirmation email failed to send", {
      organizationId,
      error: emailResult.error,
    });
  }

  return { ok: true };
}
