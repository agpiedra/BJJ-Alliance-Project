import type { ReactNode } from "react";
import { getTranslations } from "next-intl/server";
import { CircleXIcon } from "lucide-react";
import { cn } from "cn";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Pill } from "@/components/ui/pill";
import { StatRow, StatTile } from "@/components/ui/stat-tile";
import { loadMonitoringSnapshot, RECENT_EVENT_LIMIT, type JobStatusView, type Panel } from "@/lib/monitoring/load-monitoring";
import type { MonitoringAuditEvent } from "@/lib/tenant/platform-lookups";

export const dynamic = "force-dynamic";

/** Every time on this page is shown in one named zone (docs/SUPERADMIN_MONITORING_PLAN.md) — never the viewer's. */
const TIME_ZONE = "America/Costa_Rica";

type Translate = Awaited<ReturnType<typeof getTranslations<"platform.monitoring">>>;

function formatters(locale: string) {
  const intlLocale = locale === "es" ? "es-CR" : "en-US";
  const make = (options: Intl.DateTimeFormatOptions, timeZone = TIME_ZONE) => new Intl.DateTimeFormat(intlLocale, { timeZone, ...options });
  const dateTime = make({ weekday: "short", year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const withSeconds = make({ month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" });
  const offset = make({ timeZoneName: "longOffset" });
  return {
    dateTime: (date: Date) => dateTime.format(date),
    withSeconds: (date: Date) => withSeconds.format(date),
    offset: (date: Date) => offset.formatToParts(date).find((part) => part.type === "timeZoneName")?.value ?? "",
    weekday: (date: Date, timeZone: string) => make({ weekday: "long" }, timeZone).format(date),
    clock: (date: Date, timeZone: string) => make({ hour: "2-digit", minute: "2-digit", hourCycle: "h23" }, timeZone).format(date),
  };
}

type Formatters = ReturnType<typeof formatters>;

export default async function PlatformMonitoringPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const snapshot = await loadMonitoringSnapshot();
  const t = await getTranslations("platform.monitoring");
  const f = formatters(locale);

  return (
    <>
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold">{t("heading")}</h1>
        <p className="text-sm text-muted-foreground">{t("description")}</p>
        <p className="text-sm text-muted-foreground">
          {t("timeZone", { zone: TIME_ZONE, offset: f.offset(snapshot.snapshotAt) })} {t("snapshot", { time: f.dateTime(snapshot.snapshotAt) })}
        </p>
        <p className="text-sm text-muted-foreground">
          {t("window", { start: f.dateTime(snapshot.window.start), end: f.dateTime(snapshot.window.end) })}
        </p>
      </header>

      <div className="grid gap-4 lg:grid-cols-2">
        <PanelCard title={t("database.heading")} panel={snapshot.database} t={t}>
          {(database) => (
            <>
              <PanelHeading title={t("database.heading")} scope={t("database.checkedAt", { time: f.withSeconds(database.checkedAt) })} />
              <Pill variant={database.reachable ? "ok" : "bad"}>{database.reachable ? t("database.reachable") : t("database.unreachable")}</Pill>
              <p className="text-xs text-muted-foreground">{t("database.note")}</p>
            </>
          )}
        </PanelCard>

        <PanelCard title={t("jobs.heading")} panel={snapshot.jobs} t={t} tone={snapshot.jobs.status === "ok" ? jobsTone(snapshot.jobs.data) : undefined}>
          {(jobs) => (
            <>
              <PanelHeading title={t("jobs.heading")} scope={t("jobs.scope")} />
              {jobs.map((job) => (
                <JobStatus key={job.jobName} job={job} t={t} f={f} />
              ))}
            </>
          )}
        </PanelCard>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <PanelCard title={t("kiosk.heading")} panel={snapshot.kiosk} t={t}>
          {(kiosk) => (
            <>
              <PanelHeading title={t("kiosk.heading")} scope={t("kiosk.scope")} />
              <StatRow columns={3}>
                <StatTile label={t("kiosk.recordedSuccessful")} value={kiosk.recordedSuccessful} note={t("kiosk.recordedSuccessfulNote")} />
                <StatTile label={t("kiosk.countedTowardPinLimit")} value={kiosk.countedTowardPinLimit} note={t("kiosk.countedTowardPinLimitNote")} />
                <StatTile label={t("kiosk.other")} value={kiosk.other} note={t("kiosk.otherNote")} />
              </StatRow>
            </>
          )}
        </PanelCard>

        <PanelCard title={t("payments.heading")} panel={snapshot.payments} t={t}>
          {(payments) => (
            <>
              <PanelHeading title={t("payments.heading")} scope={t("payments.scope")} />
              <StatRow columns={2} className="sm:grid-cols-1">
                <StatTile label={t("payments.recordedEvents")} value={payments.recordedEvents} note={t("payments.note")} />
              </StatRow>
            </>
          )}
        </PanelCard>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <PanelCard title={t("accessDenials.heading")} panel={snapshot.accessDenials} t={t}>
          {(events) => <EventList title={t("accessDenials.heading")} note={t("accessDenials.note")} empty={t("accessDenials.empty")} events={events} t={t} f={f} />}
        </PanelCard>
        <PanelCard title={t("privilegedChanges.heading")} panel={snapshot.privilegedChanges} t={t}>
          {(events) => (
            <EventList title={t("privilegedChanges.heading")} note={t("privilegedChanges.note")} empty={t("privilegedChanges.empty")} events={events} showAction t={t} f={f} />
          )}
        </PanelCard>
      </div>

      <Card>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-col gap-0.5">
            <h2 className="text-sm font-semibold">{t("external.heading")}</h2>
            <p className="text-xs text-muted-foreground">{t("external.note")}</p>
          </div>
          <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {EXTERNAL_SIGNALS.map(([item, state]) => (
              <li key={item} className="flex flex-col gap-1 rounded-md border border-dashed border-border p-3">
                <span className="text-sm">{t(`external.items.${item}`)}</span>
                <Pill>{t(`external.${state}`)}</Pill>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </>
  );
}

/** Signals this page does not compute: no provider integration exists, and none is implied by a link. */
const EXTERNAL_SIGNALS = [
  ["requestVolume", "notConnected"],
  ["latency", "notConnected"],
  ["errorRate", "notConnected"],
  ["databaseSaturation", "notConnected"],
  ["backups", "notVerified"],
  ["storageQuota", "notVerified"],
  ["emailQuota", "notVerified"],
  ["cost", "notVerified"],
] as const;

function jobsTone(jobs: JobStatusView[]): "bad" | "warn" | undefined {
  if (jobs.some((job) => job.freshness === "overdue" || job.stuck || job.latestRun?.status === "FAILED")) return "bad";
  if (jobs.some((job) => job.freshness === "no_recorded_run" || job.latestRun?.status === "PARTIAL")) return "warn";
  return undefined;
}

function PanelHeading({ title, scope }: { title: string; scope: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
      <h2 className="text-sm font-semibold">{title}</h2>
      <span className="text-xs text-muted-foreground">{scope}</span>
    </div>
  );
}

/** "Could not load" is about this panel only, and is never rendered as zero or as an empty list. */
function PanelCard<T>({
  title,
  panel,
  tone,
  t,
  children,
}: {
  title: string;
  panel: Panel<T>;
  tone?: "bad" | "warn";
  t: Translate;
  children: (data: T) => ReactNode;
}) {
  if (panel.status === "unavailable") {
    return (
      <Card className="border-dashed border-bad-line">
        <CardContent className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold">{title}</h2>
          <p className="flex items-center gap-2 text-sm font-semibold text-bad">
            <CircleXIcon aria-hidden="true" className="size-4 shrink-0" />
            {t("unavailable.title")}
          </p>
          <p className="text-xs text-muted-foreground">{t("unavailable.body")}</p>
        </CardContent>
      </Card>
    );
  }
  return (
    <Card className={cn(tone === "bad" && "border-bad-line", tone === "warn" && "border-warn-line")}>
      <CardContent className="flex flex-col gap-3">{children(panel.data)}</CardContent>
    </Card>
  );
}

function JobStatus({ job, t, f }: { job: JobStatusView; t: Translate; f: Formatters }) {
  const { latestRun, latestSuccess } = job;
  const outcomeVariant = !latestRun ? "plain" : latestRun.status === "SUCCEEDED" ? "ok" : latestRun.status === "FAILED" ? "bad" : latestRun.status === "PARTIAL" ? "warn" : "plain";
  const freshnessVariant = job.freshness === "on_schedule" ? "ok" : job.freshness === "overdue" ? "bad" : "warn";
  const notApplicable = "—";

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        <span className="font-mono text-sm font-medium">{job.jobName}</span>
        <span className="text-xs text-muted-foreground">{describeSchedule(job, t, f)}</span>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
        <span className="flex min-w-0 flex-wrap items-center gap-1.5">
          {t("jobs.outcome")}
          <Pill variant={outcomeVariant} className="whitespace-normal">
            {latestRun ? latestRun.status : t("jobs.noHistory")}
          </Pill>
        </span>
        <span className="flex min-w-0 flex-wrap items-center gap-1.5">
          {t("jobs.freshness")}
          <Pill variant={freshnessVariant} className="whitespace-normal">
            {t(`jobs.freshnessState.${job.freshness}`)}
          </Pill>
        </span>
      </div>
      <dl className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
        <Fact label={t("jobs.latestRun")} value={latestRun ? f.dateTime(latestRun.startedAt) : t("jobs.noneRecorded")} />
        <Fact label={t("jobs.latestSuccess")} value={latestSuccess ? f.dateTime(latestSuccess.startedAt) : t("jobs.noneRecorded")} />
        <Fact label={t("jobs.failedItems")} value={latestRun ? String(latestRun.failed) : notApplicable} />
        <Fact label={t("jobs.stuck")} value={latestRun ? (job.stuck ? t("jobs.yes") : t("jobs.no")) : notApplicable} />
        <Fact
          label={t("jobs.heartbeat")}
          value={latestRun ? t(`jobs.heartbeatState.${heartbeatKey(latestRun.heartbeatStatus)}`) : notApplicable}
        />
        {job.freshUntil && (
          <Fact label={job.freshness === "overdue" ? t("jobs.overdueSince") : t("jobs.freshUntil")} value={f.dateTime(job.freshUntil)} />
        )}
      </dl>
      <p className="text-xs text-muted-foreground">{job.freshness === "no_recorded_run" ? t("jobs.neverRan") : t("jobs.threshold", { hours: job.staleAfterHours })}</p>
    </div>
  );
}

function heartbeatKey(status: string | null): "ok" | "failed" | "not_configured" | "none" {
  return status === "ok" || status === "failed" || status === "not_configured" ? status : "none";
}

/** Rendered from vercel.json's own cron expression (always UTC) — never a hardcoded day or time. */
function describeSchedule(job: JobStatusView, t: Translate, f: Formatters): string {
  if (!job.schedule) return t("jobs.scheduleMissing");
  if (!job.schedule.weekly) return t("jobs.scheduleCron", { cron: job.schedule.cron });
  const { weekday, hourUtc, minuteUtc } = job.schedule.weekly;
  // 2024-01-07 was a Sunday, so day 7 + weekday lands on the cron's weekday (0 = Sunday).
  const occurrence = new Date(Date.UTC(2024, 0, 7 + weekday, hourUtc, minuteUtc));
  return t("jobs.scheduleWeekly", {
    weekday: f.weekday(occurrence, "UTC"),
    utcTime: f.clock(occurrence, "UTC"),
    localWeekday: f.weekday(occurrence, TIME_ZONE),
    localTime: f.clock(occurrence, TIME_ZONE),
    zone: TIME_ZONE,
  });
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap gap-x-1.5">
      <dt className="text-muted-foreground">{label}:</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}

function EventList({
  title,
  note,
  empty,
  events,
  showAction = false,
  t,
  f,
}: {
  title: string;
  note: string;
  empty: string;
  events: MonitoringAuditEvent[];
  showAction?: boolean;
  t: Translate;
  f: Formatters;
}) {
  return (
    <>
      <PanelHeading title={title} scope={t("events.scope", { count: events.length, limit: RECENT_EVENT_LIMIT })} />
      {events.length === 0 ? (
        <EmptyState message={empty} className="py-6" />
      ) : (
        <ul className="flex flex-col divide-y divide-border text-xs">
          {events.map((event) => (
            <li key={event.id} className="grid gap-1 py-2 sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-3">
              <time dateTime={event.createdAt.toISOString()} className="text-muted-foreground tabular-nums">
                {f.dateTime(event.createdAt)}
              </time>
              <div className="flex min-w-0 flex-col gap-0.5">
                {showAction && <span className="font-mono break-all">{event.action}</span>}
                <span className="break-all">
                  {t("events.actor")}: <span className="font-mono">{event.actorId ?? t("events.system")}</span>
                </span>
                <span className="break-all">
                  {t("events.target")}: {event.organizationName ?? (event.entityType === "User" ? <span className="font-mono">{event.entityId}</span> : t("events.platformLevel"))}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">{note}</p>
    </>
  );
}
