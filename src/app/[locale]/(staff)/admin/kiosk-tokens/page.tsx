import { DateTime } from "luxon";
import { getLocale, getTranslations } from "next-intl/server";
import { requireTenantContext } from "@/lib/tenant/context";
import { getScopedDb } from "@/lib/tenant/scoped-client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Pill, type PillProps } from "@/components/ui/pill";
import {
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableHead,
  DataTableHeaderCell,
  DataTableHeaderRow,
  DataTableRow,
} from "@/components/ui/data-table";
import { ZONE } from "@/lib/scheduling/zone";
import { AttendanceMatchSource } from "@/generated/prisma/client";
import { RegenerateKioskTokenButton } from "./regenerate-kiosk-token-button";
import { ChangeAttendanceClassForm } from "./change-attendance-class-form";
import { QueuedCheckInForm } from "./queued-check-in-form";
import { crToday, listAcademyClasses, listPendingQueuedCheckIns, listReassignableSessions, listTodaysCheckIns } from "./queries";

// The academy list and today's check-ins both change without a redeploy —
// never frozen at build time, same reasoning as the roster/dashboard pages.
export const dynamic = "force-dynamic";

// One pill per AttendanceMatchSource. UNMATCHED is `warn`, not `bad`: the tap
// WAS saved (that is the whole point of Phase 9's never-drop-a-tap rule), it
// just has no class yet — a thing to review, not a failure.
const MATCH_SOURCE_PILL: Record<AttendanceMatchSource, { variant: PillProps["variant"]; key: string }> = {
  AUTO: { variant: "plain", key: "matchSource.AUTO" },
  STUDENT_PICKED: { variant: "ok", key: "matchSource.STUDENT_PICKED" },
  STAFF_CORRECTED: { variant: "accent", key: "matchSource.STAFF_CORRECTED" },
  UNMATCHED: { variant: "warn", key: "matchSource.UNMATCHED" },
};

export default async function KioskTokensPage() {
  // ADMIN or DIRECTOR (REDESIGN_BRIEF.md Phase 9): the `Marcajes de hoy` table
  // below is day-to-day academy operations a director owns. Regenerating the
  // shared device credential is NOT — that button stays ADMIN-only further
  // down, for the same reason this whole page used to be.
  const context = await requireTenantContext(["ADMIN", "DIRECTOR"]);

  // ADMIN sees every academy in their own organization (never another
  // tenant's); a DIRECTOR only their own — the same branch (staff)/layout.tsx
  // already uses for the academy switcher.
  const academies =
    context.academyIds === "ALL"
      ? await getScopedDb(context).academy.findMany({
          where: {},
          orderBy: { name: "asc" },
          select: { id: true, name: true, slug: true },
        })
      : await getScopedDb(context).academy.findMany({
          where: { id: { in: context.academyIds } },
          orderBy: { name: "asc" },
          select: { id: true, name: true, slug: true },
        });

  const today = crToday();
  const locale = await getLocale();
  const t = await getTranslations("adminKioskTokens");

  // One query pair per academy, resolved together. `listReassignableSessions`
  // is keyed on `today` because every row in the table is by definition on
  // today's ledger day — no per-row query needed.
  const perAcademy = await Promise.all(
    academies.map(async (academy) => ({
      academy,
      checkIns: await listTodaysCheckIns(context.organizationId, academy.id, today),
      reassignOptions: await listReassignableSessions(context.organizationId, academy.id, today),
      queued: await listPendingQueuedCheckIns(context.organizationId, academy.id),
      classes: await listAcademyClasses(context.organizationId, academy.id),
    })),
  );

  return (
    <main className="flex flex-col gap-6 p-6">
      <h1 className="text-2xl font-bold">{t("heading")}</h1>
      <p className="text-muted-foreground">{t("description")}</p>

      <div className="flex flex-col gap-4">
        {perAcademy.map(({ academy, checkIns, reassignOptions, queued, classes }) => (
          <Card key={academy.id}>
            <CardHeader>
              <CardTitle>{academy.name}</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-6">
              {context.organizationRole === "ADMIN" && (
                <RegenerateKioskTokenButton
                  organizationId={context.organizationId}
                  academyId={academy.id}
                  academySlug={academy.slug}
                />
              )}

              <section className="flex flex-col gap-3">
                <h2 className="text-sm font-semibold">{t("checkIns.heading")}</h2>

                {checkIns.length === 0 ? (
                  <EmptyState message={t("checkIns.empty")} />
                ) : (
                  <DataTable>
                    <DataTableHead>
                      <DataTableHeaderRow>
                        <DataTableHeaderCell>{t("checkIns.time")}</DataTableHeaderCell>
                        <DataTableHeaderCell>{t("checkIns.student")}</DataTableHeaderCell>
                        <DataTableHeaderCell>{t("checkIns.class")}</DataTableHeaderCell>
                        <DataTableHeaderCell>{t("checkIns.source")}</DataTableHeaderCell>
                        <DataTableHeaderCell>
                          <span className="sr-only">{t("checkIns.actions")}</span>
                        </DataTableHeaderCell>
                      </DataTableHeaderRow>
                    </DataTableHead>
                    <DataTableBody>
                      {checkIns.map((row) => {
                        const pill = MATCH_SOURCE_PILL[row.matchSource];
                        return (
                          <DataTableRow key={row.id}>
                            <DataTableCell className="font-mono tabular-nums">
                              {/* Formatted in the academy's zone, never the
                                  server's or the viewer's — same rule as every
                                  other CR time in this codebase. */}
                              {DateTime.fromJSDate(row.occurredAt, { zone: "utc" })
                                .setZone(ZONE)
                                .setLocale(locale)
                                .toFormat("HH:mm")}
                            </DataTableCell>
                            <DataTableCell>
                              {row.student.firstName} {row.student.lastName}
                            </DataTableCell>
                            <DataTableCell>
                              {row.classSession ? (
                                `${row.classSession.startTime} · ${row.classSession.name}`
                              ) : (
                                <span className="text-muted-foreground">{t("checkIns.noClass")}</span>
                              )}
                            </DataTableCell>
                            <DataTableCell>
                              <Pill variant={pill.variant}>{t(pill.key)}</Pill>
                            </DataTableCell>
                            <DataTableCell>
                              <ChangeAttendanceClassForm
                                organizationId={context.organizationId}
                                attendanceRecordId={row.id}
                                options={reassignOptions}
                              />
                            </DataTableCell>
                          </DataTableRow>
                        );
                      })}
                    </DataTableBody>
                  </DataTable>
                )}
              </section>

              {/* Queued (offline) check-ins the system could not attribute or trust: untrusted EVIDENCE, not attendances.
                  A coach records each on its original day, or sets it aside with a reason. */}
              <section className="flex flex-col gap-3" aria-labelledby={`queued-${academy.id}`}>
                <h2 id={`queued-${academy.id}`} className="text-sm font-semibold">
                  {t("queued.heading")} ({queued.length})
                </h2>
                <p className="text-sm text-muted-foreground">{t("queued.description")}</p>

                {queued.length === 0 ? (
                  <EmptyState message={t("queued.empty")} />
                ) : (
                  <DataTable>
                    <DataTableHead>
                      <DataTableHeaderRow>
                        <DataTableHeaderCell>{t("queued.student")}</DataTableHeaderCell>
                        <DataTableHeaderCell>{t("queued.claimedTime")}</DataTableHeaderCell>
                        <DataTableHeaderCell>{t("queued.claimedClass")}</DataTableHeaderCell>
                        <DataTableHeaderCell>{t("queued.reason")}</DataTableHeaderCell>
                        <DataTableHeaderCell>{t("queued.received")}</DataTableHeaderCell>
                        <DataTableHeaderCell>
                          <span className="sr-only">{t("queued.actions")}</span>
                        </DataTableHeaderCell>
                      </DataTableHeaderRow>
                    </DataTableHead>
                    <DataTableBody>
                      {queued.map((row) => {
                        const claimed = row.claimedAt ? DateTime.fromJSDate(row.claimedAt, { zone: "utc" }).setZone(ZONE).setLocale(locale) : null;
                        const claimedClass = row.claimedClassSessionId ? classes.find((option) => option.id === row.claimedClassSessionId) : undefined;
                        return (
                          <DataTableRow key={row.id}>
                            <DataTableCell>
                              {row.student.firstName} {row.student.lastName}
                            </DataTableCell>
                            <DataTableCell>
                              {/* Exactly what the tablet claimed, in the academy's zone, and never presented as a verified
                                  attendance date. */}
                              {claimed ? (
                                <span className="font-mono tabular-nums">{claimed.toLocaleString(DateTime.DATETIME_MED)}</span>
                              ) : (
                                <span className="text-muted-foreground">{t("queued.noValidTime")}</span>
                              )}{" "}
                              <Pill variant={row.claimedAtVerified ? "plain" : "warn"}>{row.claimedAtVerified ? t("queued.plausible") : t("queued.unverified")}</Pill>
                              {row.claimedAtRaw !== null && !claimed && (
                                <span className="block text-xs text-muted-foreground">{t("queued.sentAs", { raw: row.claimedAtRaw })}</span>
                              )}
                            </DataTableCell>
                            <DataTableCell>
                              {row.claimedClassSessionId === null ? (
                                <span className="text-muted-foreground">{t("queued.noClassChosen")}</span>
                              ) : claimedClass ? (
                                `${claimedClass.startTime} · ${claimedClass.name}`
                              ) : (
                                <span className="text-muted-foreground">{t("queued.unknownClass")}</span>
                              )}
                            </DataTableCell>
                            <DataTableCell>{t(`queued.reasons.${row.reason}`)}</DataTableCell>
                            <DataTableCell className="font-mono tabular-nums">
                              {DateTime.fromJSDate(row.receivedAt, { zone: "utc" }).setZone(ZONE).setLocale(locale).toLocaleString(DateTime.DATETIME_MED)}
                            </DataTableCell>
                            <DataTableCell>
                              <QueuedCheckInForm
                                organizationId={context.organizationId}
                                queuedCheckInId={row.id}
                                defaultDate={claimed ? claimed.toFormat("yyyy-MM-dd") : ""}
                                defaultTime={claimed ? claimed.toFormat("HH:mm") : ""}
                                defaultClassId={row.claimedClassSessionId}
                                classes={classes.filter((option) => option.active)}
                              />
                            </DataTableCell>
                          </DataTableRow>
                        );
                      })}
                    </DataTableBody>
                  </DataTable>
                )}
              </section>
            </CardContent>
          </Card>
        ))}
      </div>
    </main>
  );
}
