import { renderToStaticMarkup } from "react-dom/server";
import { createTranslator } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import en from "../../messages/en.json";
import es from "../../messages/es.json";
import type { MonitoringSnapshot } from "../../src/lib/monitoring/load-monitoring";

/**
 * Harness for /platform/monitoring's rendering: the real page component and real messages, with
 * only `loadMonitoringSnapshot` replaced by a fixed snapshot. Proves what the page RENDERS for each
 * panel state (including one failed panel); the loader's own isolation and authorization are
 * proven in monitoring-loader.test.ts and tests/integration/platform-monitoring.test.ts.
 */
let snapshot: MonitoringSnapshot;
// The page imports only these two values from the loader module (the rest are types).
vi.mock("@/lib/monitoring/load-monitoring", () => ({
  RECENT_EVENT_LIMIT: 50,
  loadMonitoringSnapshot: async () => snapshot,
}));

let locale: "en" | "es" = "en";
vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: string) => createTranslator({ locale, messages: locale === "en" ? en : es, namespace: namespace as never }),
}));

const { default: PlatformMonitoringPage } = await import("../../src/app/[locale]/platform/monitoring/page");

const SNAPSHOT_AT = new Date("2026-10-17T15:45:00.000Z"); // 09:45 America/Costa_Rica
const HOUR = 3_600_000;

function baseSnapshot(): MonitoringSnapshot {
  return {
    snapshotAt: SNAPSHOT_AT,
    window: { start: new Date(SNAPSHOT_AT.getTime() - 24 * HOUR), end: SNAPSHOT_AT },
    database: { status: "ok", data: { reachable: true, checkedAt: new Date(SNAPSHOT_AT.getTime() - 2_000) } },
    jobs: {
      status: "ok",
      data: [
        {
          jobName: "weekly-digest",
          schedule: { cron: "0 13 * * 1", weekly: { weekday: 1, hourUtc: 13, minuteUtc: 0 } },
          staleAfterHours: 192,
          latestRun: { status: "SUCCEEDED", startedAt: new Date(SNAPSHOT_AT.getTime() - 96 * HOUR), finishedAt: null, failed: 0, heartbeatStatus: "ok" },
          latestSuccess: { startedAt: new Date(SNAPSHOT_AT.getTime() - 96 * HOUR), finishedAt: null },
          freshness: "on_schedule",
          freshUntil: new Date(SNAPSHOT_AT.getTime() + 96 * HOUR),
          stuck: false,
        },
      ],
    },
    kiosk: { status: "ok", data: { recordedSuccessful: 41, countedTowardPinLimit: 3, other: 6 } },
    payments: { status: "ok", data: { recordedEvents: 12 } },
    accessDenials: { status: "ok", data: [] },
    privilegedChanges: { status: "ok", data: [] },
  };
}

async function renderPage(): Promise<string> {
  return renderToStaticMarkup(await PlatformMonitoringPage({ params: Promise.resolve({ locale }) }));
}

describe("/platform/monitoring page rendering (harness: mocked loader)", () => {
  it("REQUIRED: one unavailable panel renders 'Could not load' for that panel only; the others still show their data", async () => {
    locale = "en";
    snapshot = { ...baseSnapshot(), kiosk: { status: "unavailable" } };
    const html = await renderPage();

    expect(html.match(/Could not load/g)).toHaveLength(1);
    expect(html).toContain("This panel could not load. Refresh to try again.");
    expect(html).not.toContain("Attempts recorded as successful");
    expect(html).toContain("Recorded payment events");
    expect(html).toContain(">12<");
    expect(html).toContain("Reachable");
    expect(html).toContain("SUCCEEDED");
  });

  it("REQUIRED: zero activity renders zeros and empty-list messages, never 'Could not load'", async () => {
    locale = "en";
    snapshot = { ...baseSnapshot(), kiosk: { status: "ok", data: { recordedSuccessful: 0, countedTowardPinLimit: 0, other: 0 } }, payments: { status: "ok", data: { recordedEvents: 0 } } };
    const html = await renderPage();
    expect(html).not.toContain("Could not load");
    expect(html).toContain("No refused cross-organization requests in this window.");
    expect(html).toContain("No privileged changes in this window.");
  });

  it("REQUIRED: no job history renders 'No recorded run', distinct from zero activity and from a failed load", async () => {
    locale = "en";
    const base = baseSnapshot();
    if (base.jobs.status !== "ok") throw new Error("unreachable");
    snapshot = { ...base, jobs: { status: "ok", data: [{ ...base.jobs.data[0], latestRun: null, latestSuccess: null, freshness: "no_recorded_run", freshUntil: null }] } };
    const html = await renderPage();
    expect(html).toContain("No recorded run");
    expect(html).toContain("No history");
    expect(html).toContain("This job has never recorded a run. Treat it as unhealthy until it does.");
    expect(html).not.toContain("Could not load");
  });

  it("states the zone, the snapshot and the exact window, and derives the schedule from the cron", async () => {
    locale = "en";
    snapshot = baseSnapshot();
    const html = await renderPage();
    expect(html).toContain("All times in America/Costa_Rica (GMT-06:00).");
    expect(html).toContain("Activity panels: last 24 hours (Fri, Oct 16, 2026, 9:45 AM – Sat, Oct 17, 2026, 9:45 AM)");
    expect(html).toContain("Every Monday at 13:00 UTC (Monday 07:00, America/Costa_Rica)");
    expect(html).not.toMatch(/\bms\b/);
  });

  it("renders Spanish copy for the same failed-panel state", async () => {
    locale = "es";
    snapshot = { ...baseSnapshot(), accessDenials: { status: "unavailable" } };
    const html = await renderPage();
    expect(html.match(/No se pudo cargar/g)).toHaveLength(1);
    expect(html).toContain("Todas las horas en America/Costa_Rica");
  });
});
