import { DateTime } from "luxon";
import { getLocale, getTranslations } from "next-intl/server";
import { requireTenantContext, branchScopeWhere } from "@/lib/tenant/context";
import { getScopedDb } from "@/lib/tenant/scoped-client";
import { getOrganizationBranding } from "@/lib/branding/get-branding";
import { prisma } from "@/lib/prisma";
import { ZONE } from "@/lib/scheduling/zone";
import { Card, CardContent, CardHeader, CardTitle, CardAction } from "@/components/ui/card";
import { StatRow, StatTile } from "@/components/ui/stat-tile";
import { Toaster } from "@/components/ui/toast";
import { RecordPaymentForm } from "@/components/payments/record-payment-form";
import { currentCrDateParts } from "@/lib/payments/get-current-period";
import { listCurrentPaymentStatus, type CurrentPaymentRow } from "@/lib/payments/list-current-status";
import { listLedgerPaymentStatus, EMPTY_LEDGER_PAYMENT_STATUS } from "@/lib/payments/list-ledger-payment-status";
import { ensureCustomPromoPlan } from "@/lib/payments/ensure-custom-promo-plan";
import { listSelectablePlans } from "@/lib/payments/list-plans";
import { formatMonthYear } from "@/lib/format-month";
import { inactiveLedgerActivation } from "@/lib/dues/ledger/activation";
import { listStudentsForPaymentEntry } from "@/lib/dues/payment-entry-queries";
import { PaymentEntrySection } from "./payment-entry-section";
import { PackagePurchaseSection } from "./package-purchase-section";
import { PrepaymentSection } from "./prepayment-section";
import { FinancialCorrectionsSection } from "./financial-corrections-section";
import { PaymentsTable } from "./payments-table";
import { LedgerPaymentsTable } from "./ledger-payments-table";

// Same reasoning as the roster/dashboard pages: payment status is staff data
// that changes without a redeploy, so this page must never be statically
// frozen at build time.
export const dynamic = "force-dynamic";

/** Bounded name list for a stat tile's context line (Rule 5) — mirrors
 * `dashboard/page.tsx`'s own `joinNames` verbatim; not extracted to a shared
 * util for one additional caller. */
function joinNames(names: string[], max = 3): string {
  if (names.length === 0) return "";
  const shown = names.slice(0, max).join(", ");
  const remaining = names.length - max;
  return remaining > 0 ? `${shown} +${remaining}` : shown;
}

export default async function PaymentsPage() {
  const context = await requireTenantContext(["ADMIN", "DIRECTOR", "INSTRUCTOR"]);
  const t = await getTranslations("payments");
  // Same label source dashboard/page.tsx already uses for its own Decision 1 tiles — reused here, not
  // re-translated, so "Monthly past grace"/"Signup past due" read identically everywhere they appear.
  const tLedgerFilters = await getTranslations("students.ledger.filters");
  const branding = await getOrganizationBranding(context);
  const locale = await getLocale();
  const today = currentCrDateParts();

  // REDESIGN_BRIEF.md Phase 8: instructor gets a read-only Pagos view (stat
  // row + Estado del mes, no Registrar pago card, no write actions) — the
  // real enforcement stays server-side in `recordPayment`/`markPaymentPaid`
  // (both still `requireTenantContext(["ADMIN", "DIRECTOR"])`, unchanged);
  // this only decides what the page renders.
  const canRecordPayments = context.organizationRole === "ADMIN" || context.organizationRole === "DIRECTOR";

  const scope = branchScopeWhere(context);
  const academies = await getScopedDb(context).academy.findMany({
    where: {
      ...(scope.academyId ? { id: { in: scope.academyId.in } } : {}),
    },
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  });

  if (canRecordPayments) {
    await Promise.all(academies.map((academy) => ensureCustomPromoPlan(context.organizationId, academy.id)));
  }

  // §2.4/§4: resolved alone, BEFORE the Promise.all below — the legacy status-table reader
  // (`listCurrentPaymentStatus`) must never even be CALLED once active (§6: "active paths skip legacy
  // payment calculations"), not merely computed and discarded, so this decision has to exist before that
  // call site is reached. Same read-only, advisory pre-check of the real, unmodified activation singleton
  // the ordinary payment-entry UI brief §0/§2.5 already established; the engine's own checks (and, for the
  // legacy writers, `recordPayment`'s own §2.6 refusal) remain the actual enforcement either way.
  const ledgerActive = await inactiveLedgerActivation.isActive(context.organizationId);
  // §4: the one captured instant shared by every ledger read this page makes (today, exactly one —
  // `listLedgerPaymentStatus`'s own `listRosterPaymentFacts` call) — kept separate from, and never
  // substituted for, `today`'s unrelated existing role (the legacy current-month period lookup and the
  // Registrar-pago form's own month default), unaffected by this.
  const now = DateTime.now().setZone(ZONE);

  const [rows, ledgerStatus, plans, organization] = await Promise.all([
    !ledgerActive ? listCurrentPaymentStatus(context, today) : Promise.resolve<CurrentPaymentRow[]>([]),
    ledgerActive ? listLedgerPaymentStatus(context, now.toJSDate()) : Promise.resolve(EMPTY_LEDGER_PAYMENT_STATUS),
    listSelectablePlans(context.organizationId, academies.map((a) => a.id)),
    // What NEW payments are recorded in. An existing payment keeps the currency
    // it was recorded in (its own snapshot) — see PaymentPeriod.currency.
    prisma.organization.findUniqueOrThrow({ where: { id: context.organizationId }, select: { currency: true } }),
  ]);

  const students = rows.map((row) => ({
    id: row.studentId,
    firstName: row.firstName,
    lastName: row.lastName,
    academyId: row.homeAcademyId,
    academyName: row.homeAcademyName,
  }));

  // Point 6's correction: the ledger card's own picker is NOT `students` above (that list is `listCurrentPaymentStatus`'s
  // own `status: "ACTIVE"`-filtered roster, correct for the legacy flow, wrong here — real ledger debt does not depend
  // on current billing eligibility). Fetched only when the card can actually render.
  const paymentEntryStudents = canRecordPayments && ledgerActive ? await listStudentsForPaymentEntry(context) : [];

  const paidRows = rows.filter((r) => r.bucket === "PAID");
  const pendingRows = rows.filter((r) => r.bucket === "PENDING");
  const overdueRows = rows.filter((r) => r.bucket === "OVERDUE");
  const promoRows = rows.filter((r) => r.bucket === "PROMO_OR_EXEMPT");

  const monthLabel = formatMonthYear(today.year, today.month, locale);
  const academyLabel = academies.map((a) => a.name).join(` ${t("academyJoin")} `);

  return (
    <main className="flex flex-col gap-6 p-4 sm:p-6">
      <header className="flex flex-col gap-1">
        <p className="font-mono text-[10.5px] tracking-[.11em] text-muted-foreground uppercase">{t("eyebrow", { orgName: branding.displayName })}</p>
        <h1>{t("heading")}</h1>
        <p className="text-sm text-muted-foreground">
          {t("sub", { month: monthLabel, academy: academyLabel })}
        </p>
        {canRecordPayments && (
          <a href={`/${locale}/payments/plans`} className="text-sm underline pointer-coarse:py-3">
            {t("plansLink")}
          </a>
        )}
      </header>

      {/* §2.4: "the legacy stat row/table is replaced wholesale when ledgerActive" — never shown alongside
          the ledger tiles below, the same replacement ternary every other current-status consumer in this
          cutover already follows. The ledger tiles reuse Decision 1's own two-count shape (never a new
          metric); `unknownCount` (§6.2) is shown on both, since both come from the same read. */}
      {!ledgerActive ? (
        <StatRow columns={4}>
          <StatTile
            label={t("stats.paid.label")}
            value={paidRows.length}
            note={t("stats.paid.note", { total: rows.length })}
          />
          <StatTile
            label={t("stats.pending.label")}
            value={pendingRows.length}
            note={joinNames(pendingRows.map((r) => `${r.firstName} ${r.lastName}`)) || undefined}
          />
          <StatTile
            label={t("stats.overdue.label")}
            value={overdueRows.length}
            flag="bad"
            note={joinNames(overdueRows.map((r) => `${r.firstName} ${r.lastName}`)) || undefined}
          />
          <StatTile
            label={t("stats.promo.label")}
            value={promoRows.length}
            note={joinNames(promoRows.map((r) => `${r.firstName} ${r.lastName}`)) || undefined}
          />
        </StatRow>
      ) : (
        <StatRow columns={2}>
          <StatTile
            label={tLedgerFilters("monthlyPastGrace")}
            value={ledgerStatus.summary.monthlyPastGraceCount}
            flag="bad"
            note={ledgerStatus.summary.unknownCount > 0 ? t("stats.unknownSuffix", { count: ledgerStatus.summary.unknownCount }) : undefined}
          />
          <StatTile
            label={tLedgerFilters("signupPastDue")}
            value={ledgerStatus.summary.signupPastDueCount}
            flag="bad"
            note={ledgerStatus.summary.unknownCount > 0 ? t("stats.unknownSuffix", { count: ledgerStatus.summary.unknownCount }) : undefined}
          />
        </StatRow>
      )}

      {/* ADMIN/DIRECTOR only — an INSTRUCTOR who reaches this page (Phase 8's
          read-only grant) never sees this card at all, matching the
          student-detail page's own `canEdit` gate for the identical form.
          `recordPayment`/`markPaymentPaid` re-enforce the same gate
          server-side regardless. */}
      {/* REMAINING-LEDGER-CONSUMERS-BRIEF.md §2.6: this legacy write control is hidden once the ledger is active
          for this organization — `recordPayment` itself refuses server-side regardless (the real enforcement),
          this only avoids offering a control that would always be refused. Preserves the exact unconditional
          rendering when inactive. */}
      {canRecordPayments && !ledgerActive && (
        <Card>
          <CardHeader className="border-b">
            <CardTitle>{t("recordCard.heading")}</CardTitle>
            <CardAction className="text-xs text-muted-foreground">{t("recordCard.note")}</CardAction>
          </CardHeader>
          <CardContent className="pt-4">
            <RecordPaymentForm
              organizationId={context.organizationId}
              students={students}
              plans={plans}
              canManagePromotions={canRecordPayments}
              currency={organization.currency}
              defaults={{ month: `${today.year}-${String(today.month).padStart(2, "0")}` }}
            />
          </CardContent>
        </Card>
      )}

      {/* Ordinary payment-entry UI brief §0: a NEW, clearly separate, inactive-gated card on this SAME page,
          never a new top-level route, alongside (not replacing) the legacy RecordPaymentForm card above. */}
      {canRecordPayments && ledgerActive && (
        <Card>
          <CardHeader className="border-b">
            <CardTitle>{t("ledgerEntry.heading")}</CardTitle>
          </CardHeader>
          <CardContent className="pt-4">
            <PaymentEntrySection
              organizationId={context.organizationId}
              currentUserId={context.actorUserId}
              students={paymentEntryStudents.map((s) => ({ id: s.id, firstName: s.firstName, lastName: s.lastName, academyId: s.homeAcademyId, academyName: s.homeAcademyName }))}
              organizationRole={context.organizationRole === "ADMIN" ? "ADMIN" : "DIRECTOR"}
              plansHref={`/${locale}/payments/plans`}
            />
          </CardContent>
        </Card>
      )}

      {/* Package-purchase UI brief §0/§2.12: a NEW, separate, inactive-gated card, ADMIN-only display (matching
          `purchasePackageWithSubmissionIdentity`'s own hard-coded ADMIN-only check — never DIRECTOR), mounted
          alongside the ordinary ledger card above, never on `payments/plans/page.tsx`. */}
      {context.organizationRole === "ADMIN" && ledgerActive && (
        <Card>
          <CardHeader className="border-b">
            <CardTitle>{t("packagePurchase.heading")}</CardTitle>
          </CardHeader>
          <CardContent className="pt-4">
            <PackagePurchaseSection
              organizationId={context.organizationId}
              currentUserId={context.actorUserId}
              students={paymentEntryStudents.map((s) => ({ id: s.id, firstName: s.firstName, lastName: s.lastName, academyId: s.homeAcademyId, academyName: s.homeAcademyName }))}
              plansHref={`/${locale}/payments/plans`}
            />
          </CardContent>
        </Card>
      )}

      {/* Monthly-prepayment UI brief §0: a NEW, separate, inactive-gated card, ADMIN-only display (matching
          `prepayMonthlyObligationsWithSubmissionIdentity`'s own hard-coded ADMIN-only check — never DIRECTOR),
          mounted alongside the ordinary ledger and package-purchase cards above, never on `payments/plans/page.tsx`. */}
      {context.organizationRole === "ADMIN" && ledgerActive && (
        <Card>
          <CardHeader className="border-b">
            <CardTitle>{t("prepayment.heading")}</CardTitle>
          </CardHeader>
          <CardContent className="pt-4">
            <PrepaymentSection
              organizationId={context.organizationId}
              currentUserId={context.actorUserId}
              students={paymentEntryStudents.map((s) => ({ id: s.id, firstName: s.firstName, lastName: s.lastName, academyId: s.homeAcademyId, academyName: s.homeAcademyName }))}
              plansHref={`/${locale}/payments/plans`}
            />
          </CardContent>
        </Card>
      )}

      {/* Owner financial-corrections UI brief §0: a NEW, separate, inactive-gated card, ADMIN-only display (all three
          composed writers — correctLateFeeAndSettle/reversePayment/waiveLateFee — are hard-coded ADMIN-only
          themselves), mounted alongside the three ledger-writing cards above, never on `payments/plans/page.tsx`. */}
      {context.organizationRole === "ADMIN" && ledgerActive && (
        <Card>
          <CardHeader className="border-b">
            <CardTitle>{t("financialCorrections.heading")}</CardTitle>
          </CardHeader>
          <CardContent className="pt-4">
            <FinancialCorrectionsSection
              organizationId={context.organizationId}
              students={paymentEntryStudents.map((s) => ({ id: s.id, firstName: s.firstName, lastName: s.lastName, academyId: s.homeAcademyId, academyName: s.homeAcademyName }))}
            />
          </CardContent>
        </Card>
      )}

      {/* §2.4: the active-path ledger table REPLACES this card's legacy table wholesale — the two are never
          both mounted at once, so there is never a second, competing current-status table on this page. */}
      <Card>
        <CardHeader className="border-b">
          <CardTitle>{ledgerActive ? t("statusCard.ledgerHeading") : t("statusCard.heading")}</CardTitle>
          <CardAction className="text-xs text-muted-foreground">
            {ledgerActive ? t("statusCard.ledgerNote", { academy: academyLabel }) : t("statusCard.note", { month: monthLabel, academy: academyLabel })}
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 pt-4">
          {ledgerActive ? (
            <LedgerPaymentsTable rows={ledgerStatus.rows} academies={academies} locale={locale} />
          ) : (
            <PaymentsTable
              organizationId={context.organizationId}
              rows={rows}
              plans={plans}
              academies={academies}
              currentYear={today.year}
              currentMonth={today.month}
              canRecordPayments={canRecordPayments}
              ledgerActive={ledgerActive}
              locale={locale}
            />
          )}
        </CardContent>
      </Card>

      <Toaster />
    </main>
  );
}
