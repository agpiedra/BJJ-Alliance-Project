"use server";

import { revalidatePath } from "next/cache";
import { getLocale } from "next-intl/server";
import { Prisma, type Currency } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { isAcademyInTenantScope, resolveActionContext } from "@/lib/tenant/context";
import { isCustomPromoPlanName } from "@/lib/payments/custom-promo-plan-name";
import { CURRENCIES } from "@/lib/payments/format-money";
import type { ActionState } from "@/lib/action-state";
import { compareYearMonth, type YearMonth } from "@/lib/dues/calendar";
import {
  MAX_SUPPORTED_MONTHS,
  currenciesCompatible,
  currentMonthIn,
  parseEffectiveMonth,
  parseMoney,
  parseWholeNumber,
  policyRevision,
  termsRevision,
  type Parsed,
} from "@/lib/dues/config-input";

/**
 * Owner configuration of student dues (PR 3): plan terms (price, currency, months covered) and a branch's dues policy (due day, grace
 * day, late fee, prepayment limit), each versioned by effective month.
 *
 * SAVING CONFIGURATION DOES NOT ACTIVATE BILLING. Nothing here creates an obligation, coverage, a payment or an assignment, and the
 * legacy payment flow keeps its own rules. The only legacy code that reads these tables is the package guard in `package-plans.ts`.
 *
 * Rules every action follows:
 *  - OWNERS ONLY (`ADMIN`): a required role list. A real member with another role throws FORBIDDEN like every owner-only action here; a
 *    non-member or signed-out caller gets `notFound`. Ids in the form are never trusted: each is re-read scoped to the organization.
 *  - EXACT INPUT: money and numbers are parsed from the typed text (`config-input.ts`); nothing is rounded or repaired.
 *  - ONE TRANSACTION PER SAVE, SERIALIZED PER BRANCH: the first statement locks the branch's `Academy` row (`FOR UPDATE`), so two saves
 *    for one branch queue behind each other and every check below (single currency, one version per month, plan kind, revision) is made
 *    against state no other save can change until this one commits. The database cannot enforce these rules itself (they span rows and
 *    tables), so the lock is what keeps them true under simultaneous writes.
 *  - VERSIONS ARE INSERT-ONLY, with ONE approved exception (D25): a version whose effective month is still in the future in the BRANCH's
 *    timezone may be corrected, atomically with a before/after audit row and only if the editor's revision token still matches (a stale
 *    edit is refused, never merged over someone else's). A current or past version is never changed.
 *  - D24: a blank prepayment limit is saved as NULL, "not entered". No default is applied anywhere.
 *
 * BEFORE ANY FINANCIAL WRITER SHIPS (ledger PR 2B onward): a future version CAN be depended on by a future prepayment, so the "future
 * versions are editable" exception above must be narrowed first. Versions a sold, assigned or prepaid obligation references have to be
 * protected, and the price and coverage already paid must stay frozen. Nothing references a version today, so nothing can be affected.
 */

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];
type Rejection = { rejected: string };

/** Fail with a message key instead of an exception; the transaction commits nothing when a check returns one of these. */
const reject = (code: string): Rejection => ({ rejected: code });

const text = (formData: FormData, name: string): string | null => {
  const value = formData.get(name);
  return typeof value === "string" ? value : null;
};

function parseCurrency(raw: string | null): Parsed<Currency> {
  return raw !== null && (CURRENCIES as readonly string[]).includes(raw) ? { ok: true, value: raw as Currency } : { ok: false };
}

/** Collects a field's error under its name; undefined when it did not parse. */
function take<T>(errors: Record<string, string[]>, name: string, parsed: Parsed<T>): T | undefined {
  if (!parsed.ok) {
    errors[name] = ["invalid"];
    return undefined;
  }
  return parsed.value;
}

const invalid = (errors: Record<string, string[]>): ActionState => ({ error: "invalid", fieldErrors: errors });

type TermsInput = { priceAmount: string; currency: Currency; monthsCovered: number };
type PolicyInput = { dueDay: number; graceDay: number; lateFeeAmount: string; lateFeeCurrency: Currency; maxPrepaidMonths: number | null };

function readTerms(formData: FormData, minMonths: number): { value: TermsInput } | { errors: Record<string, string[]> } {
  const errors: Record<string, string[]> = {};
  const priceAmount = take(errors, "priceAmount", parseMoney(text(formData, "priceAmount"), { allowZero: false }));
  const currency = take(errors, "currency", parseCurrency(text(formData, "currency")));
  const monthsCovered = take(errors, "monthsCovered", parseWholeNumber(text(formData, "monthsCovered"), minMonths, MAX_SUPPORTED_MONTHS));
  if (priceAmount === undefined || currency === undefined || monthsCovered === undefined) return { errors };
  return { value: { priceAmount, currency, monthsCovered } };
}

function readPolicy(formData: FormData): { value: PolicyInput } | { errors: Record<string, string[]> } {
  const errors: Record<string, string[]> = {};
  const dueDay = take(errors, "dueDay", parseWholeNumber(text(formData, "dueDay"), 1, 31));
  const graceDay = take(errors, "graceDay", parseWholeNumber(text(formData, "graceDay"), 1, 31));
  const lateFeeAmount = take(errors, "lateFeeAmount", parseMoney(text(formData, "lateFeeAmount"), { allowZero: true }));
  const lateFeeCurrency = take(errors, "lateFeeCurrency", parseCurrency(text(formData, "lateFeeCurrency")));
  // Blank = "not entered" (D24). Anything else must be a whole number the calendar supports.
  const limitRaw = text(formData, "maxPrepaidMonths");
  const limit: Parsed<number | null> =
    limitRaw === null || limitRaw === "" ? { ok: true, value: null } : parseWholeNumber(limitRaw, 1, MAX_SUPPORTED_MONTHS);
  const maxPrepaidMonths = take(errors, "maxPrepaidMonths", limit);
  if (dueDay === undefined || graceDay === undefined || lateFeeAmount === undefined || lateFeeCurrency === undefined || maxPrepaidMonths === undefined) {
    return { errors };
  }
  return { value: { dueDay, graceDay, lateFeeAmount, lateFeeCurrency, maxPrepaidMonths } };
}

/**
 * Locks the branch and returns its timezone, or null when it is not in the organization. Every save starts here: holding the row makes
 * the saves for one branch strictly sequential, and the timezone is read under the same lock.
 */
async function lockBranch(tx: Tx, organizationId: string, academyId: string): Promise<{ timezone: string } | null> {
  const rows = await tx.$queryRaw<{ timezone: string }[]>`
    SELECT "timezone" FROM "Academy" WHERE "id" = ${academyId} AND "organizationId" = ${organizationId} FOR UPDATE`;
  return rows[0] ?? null;
}

/** Every currency the branch's dues configuration already uses (plan terms of any plan of the branch, and fees), optionally without one row. */
async function branchCurrencies(
  tx: Tx,
  organizationId: string,
  academyId: string,
  exclude: { termsId?: string; policyId?: string } = {},
): Promise<Currency[]> {
  const terms = await tx.paymentPlanTerms.findMany({
    where: { organizationId, plan: { academyId }, ...(exclude.termsId ? { id: { not: exclude.termsId } } : {}) },
    select: { currency: true },
    distinct: ["currency"],
  });
  const policies = await tx.duesPolicyVersion.findMany({
    where: { organizationId, academyId, ...(exclude.policyId ? { id: { not: exclude.policyId } } : {}) },
    select: { lateFeeCurrency: true },
    distinct: ["lateFeeCurrency"],
  });
  return [...terms.map((t) => t.currency), ...policies.map((p) => p.lateFeeCurrency)];
}

const termsSnapshot = (row: { planId: string; effectiveYear: number; effectiveMonth: number; priceAmount: Prisma.Decimal; currency: Currency; monthsCovered: number }) => ({
  planId: row.planId,
  effectiveYear: row.effectiveYear,
  effectiveMonth: row.effectiveMonth,
  // A string, so the exact amount survives JSON.
  priceAmount: row.priceAmount.toFixed(2),
  currency: row.currency,
  monthsCovered: row.monthsCovered,
});

const policySnapshot = (row: {
  academyId: string;
  effectiveYear: number;
  effectiveMonth: number;
  dueDay: number;
  graceDay: number;
  lateFeeAmount: Prisma.Decimal;
  lateFeeCurrency: Currency;
  maxPrepaidMonths: number | null;
}) => ({
  academyId: row.academyId,
  effectiveYear: row.effectiveYear,
  effectiveMonth: row.effectiveMonth,
  dueDay: row.dueDay,
  graceDay: row.graceDay,
  lateFeeAmount: row.lateFeeAmount.toFixed(2),
  lateFeeCurrency: row.lateFeeCurrency,
  maxPrepaidMonths: row.maxPrepaidMonths,
});

async function refreshPlanPages(): Promise<void> {
  // Best-effort, same shape as plan-actions: a direct test call has no request-scoped store, and the write has already committed.
  try {
    const locale = await getLocale();
    revalidatePath(`/${locale}/payments/plans`);
  } catch (error) {
    console.error("[dues-config-actions] failed to revalidate", { error });
  }
}

const isUniqueViolation = (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";

/** Runs a save's transaction and turns a rejection (or the unique constraint, the backstop) into the action's result. */
async function commit(work: () => Promise<Rejection | null>, uniqueError: string): Promise<ActionState> {
  let outcome: Rejection | null;
  try {
    outcome = await work();
  } catch (error) {
    if (isUniqueViolation(error)) return { error: uniqueError };
    throw error;
  }
  if (outcome) return { error: outcome.rejected };
  await refreshPlanPages();
  return { ok: true };
}

const monthOf = (row: { effectiveYear: number; effectiveMonth: number }): YearMonth => ({ year: row.effectiveYear, month: row.effectiveMonth });

/** Add a terms version (price, currency, months covered) to an existing plan, effective from a month. */
export async function addPlanTerms(organizationId: string, _prevState: ActionState, formData: FormData): Promise<ActionState> {
  const auth = await resolveActionContext(organizationId, ["ADMIN"]);
  if (!auth.ok) return { error: "notFound" };
  const context = auth.context;

  const planId = text(formData, "planId");
  const plan = planId
    ? await prisma.paymentPlan.findUnique({ where: { id: planId, organizationId: context.organizationId }, select: { id: true, academyId: true, name: true } })
    : null;
  if (!plan || !isAcademyInTenantScope(context, plan.academyId)) return { error: "notFound" };
  if (isCustomPromoPlanName(plan.name)) return { error: "systemPlan" };

  const month = parseEffectiveMonth(text(formData, "effectiveYear"), text(formData, "effectiveMonth"));
  const terms = readTerms(formData, 1);
  if (!month.ok || "errors" in terms) {
    return invalid({ ...("errors" in terms ? terms.errors : {}), ...(month.ok ? {} : { effectiveMonth: ["invalid"] }) });
  }
  const input = terms.value;

  return commit(
    () =>
      prisma.$transaction(async (tx) => {
        const branch = await lockBranch(tx, context.organizationId, plan.academyId);
        if (!branch) return reject("notFound");
        if (compareYearMonth(month.value, currentMonthIn(branch.timezone)) < 0) return reject("pastMonth");

        const existing = await tx.paymentPlanTerms.findMany({
          where: { organizationId: context.organizationId, planId: plan.id },
          select: { effectiveYear: true, effectiveMonth: true, monthsCovered: true },
        });
        if (existing.some((t) => t.effectiveYear === month.value.year && t.effectiveMonth === month.value.month)) return reject("versionExists");
        // A plan is monthly or a package for its whole life: multi-month terms belong to a package plan made by createPackagePlan.
        if (input.monthsCovered > 1 !== existing.some((t) => t.monthsCovered > 1)) return reject("durationMismatch");
        if (!currenciesCompatible(await branchCurrencies(tx, context.organizationId, plan.academyId), input.currency)) return reject("currencyMismatch");

        const created = await tx.paymentPlanTerms.create({
          data: {
            organizationId: context.organizationId,
            planId: plan.id,
            effectiveYear: month.value.year,
            effectiveMonth: month.value.month,
            priceAmount: input.priceAmount,
            currency: input.currency,
            monthsCovered: input.monthsCovered,
            createdById: context.actorUserId,
          },
        });
        await tx.auditLog.create({
          data: {
            actorId: context.actorUserId,
            organizationId: context.organizationId,
            academyId: plan.academyId,
            action: "duesPlanTerms.create",
            entityType: "PaymentPlanTerms",
            entityId: created.id,
            before: Prisma.DbNull,
            after: termsSnapshot(created),
          },
        });
        return null;
      }),
    "versionExists",
  );
}

/** Add a dues policy version (due day, grace day, late fee, prepayment limit) to a branch, effective from a month. */
export async function addPolicyVersion(organizationId: string, _prevState: ActionState, formData: FormData): Promise<ActionState> {
  const auth = await resolveActionContext(organizationId, ["ADMIN"]);
  if (!auth.ok) return { error: "notFound" };
  const context = auth.context;

  const academyId = text(formData, "academyId");
  if (academyId === null || !isAcademyInTenantScope(context, academyId)) return { error: "notFound" };
  const academy = await prisma.academy.findUnique({ where: { id: academyId, organizationId: context.organizationId }, select: { id: true } });
  if (!academy) return { error: "notFound" };

  const month = parseEffectiveMonth(text(formData, "effectiveYear"), text(formData, "effectiveMonth"));
  const policy = readPolicy(formData);
  if (!month.ok || "errors" in policy) {
    return invalid({ ...("errors" in policy ? policy.errors : {}), ...(month.ok ? {} : { effectiveMonth: ["invalid"] }) });
  }
  const input = policy.value;

  return commit(
    () =>
      prisma.$transaction(async (tx) => {
        const branch = await lockBranch(tx, context.organizationId, academy.id);
        if (!branch) return reject("notFound");
        if (compareYearMonth(month.value, currentMonthIn(branch.timezone)) < 0) return reject("pastMonth");

        const sameMonth = await tx.duesPolicyVersion.findUnique({
          where: {
            academyId_effectiveYear_effectiveMonth: { academyId: academy.id, effectiveYear: month.value.year, effectiveMonth: month.value.month },
            organizationId: context.organizationId,
          },
          select: { id: true },
        });
        if (sameMonth) return reject("versionExists");
        if (!currenciesCompatible(await branchCurrencies(tx, context.organizationId, academy.id), input.lateFeeCurrency)) return reject("currencyMismatch");

        const created = await tx.duesPolicyVersion.create({
          data: {
            organizationId: context.organizationId,
            academyId: academy.id,
            effectiveYear: month.value.year,
            effectiveMonth: month.value.month,
            ...input,
            createdById: context.actorUserId,
          },
        });
        await tx.auditLog.create({
          data: {
            actorId: context.actorUserId,
            organizationId: context.organizationId,
            academyId: academy.id,
            action: "duesPolicy.create",
            entityType: "DuesPolicyVersion",
            entityId: created.id,
            before: Prisma.DbNull,
            after: policySnapshot(created),
          },
        });
        return null;
      }),
    "versionExists",
  );
}

/**
 * Create a PACKAGE plan: the plan and its first terms in ONE transaction, so a package plan never exists without multi-month terms (that
 * is what makes it invisible to the legacy payment flow from its first moment). A package needs at least two months.
 */
export async function createPackagePlan(organizationId: string, _prevState: ActionState, formData: FormData): Promise<ActionState> {
  const auth = await resolveActionContext(organizationId, ["ADMIN"]);
  if (!auth.ok) return { error: "notFound" };
  const context = auth.context;

  const academyId = text(formData, "academyId");
  if (academyId === null || !isAcademyInTenantScope(context, academyId)) return { error: "notFound" };
  const academy = await prisma.academy.findUnique({ where: { id: academyId, organizationId: context.organizationId }, select: { id: true } });
  if (!academy) return { error: "notFound" };

  const errors: Record<string, string[]> = {};
  const name = (text(formData, "name") ?? "").trim();
  const description = (text(formData, "description") ?? "").trim();
  if (name.length < 1 || name.length > 80) errors.name = ["invalid"];
  if (description.length > 200) errors.description = ["invalid"];
  const month = parseEffectiveMonth(text(formData, "effectiveYear"), text(formData, "effectiveMonth"));
  if (!month.ok) errors.effectiveMonth = ["invalid"];
  const terms = readTerms(formData, 2);
  if ("errors" in terms) Object.assign(errors, terms.errors);
  if (Object.keys(errors).length > 0 || !month.ok || "errors" in terms) return invalid(errors);
  if (isCustomPromoPlanName(name)) return { error: "systemPlan" };
  const input = terms.value;

  return commit(
    () =>
      prisma.$transaction(async (tx) => {
        const branch = await lockBranch(tx, context.organizationId, academy.id);
        if (!branch) return reject("notFound");
        if (compareYearMonth(month.value, currentMonthIn(branch.timezone)) < 0) return reject("pastMonth");

        const clash = await tx.paymentPlan.findUnique({
          where: { academyId_name: { academyId: academy.id, name }, organizationId: context.organizationId },
          select: { active: true },
        });
        if (clash) return reject(clash.active ? "nameTaken" : "nameTakenInactive");
        if (!currenciesCompatible(await branchCurrencies(tx, context.organizationId, academy.id), input.currency)) return reject("currencyMismatch");

        const plan = await tx.paymentPlan.create({
          data: { organizationId: context.organizationId, academyId: academy.id, name, description: description || null },
        });
        const created = await tx.paymentPlanTerms.create({
          data: {
            organizationId: context.organizationId,
            planId: plan.id,
            effectiveYear: month.value.year,
            effectiveMonth: month.value.month,
            priceAmount: input.priceAmount,
            currency: input.currency,
            monthsCovered: input.monthsCovered,
            createdById: context.actorUserId,
          },
        });
        await tx.auditLog.createMany({
          data: [
            {
              actorId: context.actorUserId,
              organizationId: context.organizationId,
              academyId: academy.id,
              action: "paymentPlan.create",
              entityType: "PaymentPlan",
              entityId: plan.id,
              before: Prisma.DbNull,
              after: { name: plan.name, description: plan.description, defaultAmount: null, active: plan.active, package: true },
            },
            {
              actorId: context.actorUserId,
              organizationId: context.organizationId,
              academyId: academy.id,
              action: "duesPlanTerms.create",
              entityType: "PaymentPlanTerms",
              entityId: created.id,
              before: Prisma.DbNull,
              after: termsSnapshot(created),
            },
          ],
        });
        return null;
      }),
    "nameTaken",
  );
}

/**
 * D25: correct a terms version whose effective month is still in the future in the branch's timezone. Current and past versions are
 * immutable. `expectedRevision` is the token the editor loaded; if the row changed since, the edit is `stale` and nothing is written.
 * The plan keeps its kind (monthly stays monthly, a package stays a package) and the branch keeps its single currency.
 */
export async function correctPlanTerms(organizationId: string, _prevState: ActionState, formData: FormData): Promise<ActionState> {
  const auth = await resolveActionContext(organizationId, ["ADMIN"]);
  if (!auth.ok) return { error: "notFound" };
  const context = auth.context;

  const termsId = text(formData, "termsId");
  const expectedRevision = text(formData, "expectedRevision");
  const found = termsId
    ? await prisma.paymentPlanTerms.findFirst({
        where: { id: termsId, organizationId: context.organizationId },
        select: { id: true, plan: { select: { academyId: true } } },
      })
    : null;
  if (!found || !isAcademyInTenantScope(context, found.plan.academyId)) return { error: "notFound" };

  const terms = readTerms(formData, 1);
  if ("errors" in terms || expectedRevision === null) return invalid("errors" in terms ? terms.errors : { expectedRevision: ["invalid"] });
  const input = terms.value;
  const academyId = found.plan.academyId;

  return commit(
    () =>
      prisma.$transaction(async (tx) => {
        const branch = await lockBranch(tx, context.organizationId, academyId);
        if (!branch) return reject("notFound");
        // Re-read under the lock: this is the row every check below is about.
        const row = await tx.paymentPlanTerms.findFirst({ where: { id: found.id, organizationId: context.organizationId } });
        if (!row) return reject("notFound");
        if (compareYearMonth(monthOf(row), currentMonthIn(branch.timezone)) <= 0) return reject("notFuture");
        if (termsRevision(row) !== expectedRevision) return reject("stale");
        if (input.monthsCovered > 1 !== row.monthsCovered > 1) return reject("durationMismatch");
        if (!currenciesCompatible(await branchCurrencies(tx, context.organizationId, academyId, { termsId: row.id }), input.currency)) {
          return reject("currencyMismatch");
        }

        const updated = await tx.paymentPlanTerms.update({
          where: { id: row.id, organizationId: context.organizationId },
          data: { priceAmount: input.priceAmount, currency: input.currency, monthsCovered: input.monthsCovered },
        });
        await tx.auditLog.create({
          data: {
            actorId: context.actorUserId,
            organizationId: context.organizationId,
            academyId,
            action: "duesPlanTerms.correct",
            entityType: "PaymentPlanTerms",
            entityId: row.id,
            before: termsSnapshot(row),
            after: termsSnapshot(updated),
          },
        });
        return null;
      }),
    "versionExists",
  );
}

/** D25 for a branch policy version: same rules as `correctPlanTerms`. */
export async function correctPolicyVersion(organizationId: string, _prevState: ActionState, formData: FormData): Promise<ActionState> {
  const auth = await resolveActionContext(organizationId, ["ADMIN"]);
  if (!auth.ok) return { error: "notFound" };
  const context = auth.context;

  const policyId = text(formData, "policyId");
  const expectedRevision = text(formData, "expectedRevision");
  const found = policyId
    ? await prisma.duesPolicyVersion.findFirst({ where: { id: policyId, organizationId: context.organizationId }, select: { id: true, academyId: true } })
    : null;
  if (!found || !isAcademyInTenantScope(context, found.academyId)) return { error: "notFound" };

  const policy = readPolicy(formData);
  if ("errors" in policy || expectedRevision === null) return invalid("errors" in policy ? policy.errors : { expectedRevision: ["invalid"] });
  const input = policy.value;

  return commit(
    () =>
      prisma.$transaction(async (tx) => {
        const branch = await lockBranch(tx, context.organizationId, found.academyId);
        if (!branch) return reject("notFound");
        const row = await tx.duesPolicyVersion.findFirst({ where: { id: found.id, organizationId: context.organizationId } });
        if (!row) return reject("notFound");
        if (compareYearMonth(monthOf(row), currentMonthIn(branch.timezone)) <= 0) return reject("notFuture");
        if (policyRevision(row) !== expectedRevision) return reject("stale");
        if (!currenciesCompatible(await branchCurrencies(tx, context.organizationId, found.academyId, { policyId: row.id }), input.lateFeeCurrency)) {
          return reject("currencyMismatch");
        }

        const updated = await tx.duesPolicyVersion.update({ where: { id: row.id, organizationId: context.organizationId }, data: input });
        await tx.auditLog.create({
          data: {
            actorId: context.actorUserId,
            organizationId: context.organizationId,
            academyId: found.academyId,
            action: "duesPolicy.correct",
            entityType: "DuesPolicyVersion",
            entityId: row.id,
            before: policySnapshot(row),
            after: policySnapshot(updated),
          },
        });
        return null;
      }),
    "versionExists",
  );
}
