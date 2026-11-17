import { afterEach, describe, expect, it, vi } from "vitest";
import { digestSwitch } from "../../src/lib/jobs/digest-switch";
import { classifyJob } from "../../src/lib/monitoring/load-monitoring";
import { STALE_AFTER_HOURS, STUCK_AFTER_MINUTES } from "../../src/lib/jobs/job-health";

/** Weekly digest per-environment switch (docs/dues/WEEKLY-DIGEST-SWITCH-PROPOSAL.md): parsing and monitoring classification. */
describe("digestSwitch: WEEKLY_DIGEST_ENABLED", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("unset, empty or blank is intentionally disabled (the safe default)", () => {
    expect(digestSwitch({})).toEqual({ state: "disabled", reason: "unset" });
    expect(digestSwitch({ WEEKLY_DIGEST_ENABLED: "" })).toEqual({ state: "disabled", reason: "unset" });
    expect(digestSwitch({ WEEKLY_DIGEST_ENABLED: "   " })).toEqual({ state: "disabled", reason: "unset" });
  });

  it("exactly `false` (spaces ignored) is intentionally disabled", () => {
    for (const v of ["false", " false ", "false\n"]) expect(digestSwitch({ WEEKLY_DIGEST_ENABLED: v })).toEqual({ state: "disabled", reason: "false" });
  });

  it("only exactly `true` (spaces ignored) enables it", () => {
    for (const v of ["true", " true ", "\ttrue"]) expect(digestSwitch({ WEEKLY_DIGEST_ENABLED: v })).toEqual({ state: "enabled" });
  });

  it("any other value is misconfigured, never enabled", () => {
    for (const v of ["TRUE", "True", "FALSE", "yes", "1", "0", "on", "enabled", "true,false", "'true'", "tru"]) {
      expect(digestSwitch({ WEEKLY_DIGEST_ENABLED: v })).toEqual({ state: "misconfigured" });
    }
  });

  it("reads process.env by default", () => {
    vi.stubEnv("WEEKLY_DIGEST_ENABLED", "true");
    expect(digestSwitch()).toEqual({ state: "enabled" });
    vi.stubEnv("WEEKLY_DIGEST_ENABLED", "false");
    expect(digestSwitch()).toEqual({ state: "disabled", reason: "false" });
  });
});

describe("classifyJob with the digest switch", () => {
  const now = new Date("2026-11-17T12:00:00.000Z").getTime();
  const old = new Date(now - ((STALE_AFTER_HOURS["weekly-digest"] as number) + 5) * 3_600_000);
  const overdue = { latestRun: { status: "SUCCEEDED", startedAt: old, finishedAt: old, failed: 0, heartbeatStatus: "ok" }, latestSuccess: { startedAt: old, finishedAt: old } };
  const stuckRun = { latestRun: { status: "RUNNING", startedAt: new Date(now - (STUCK_AFTER_MINUTES + 1) * 60_000), finishedAt: null, failed: 0, heartbeatStatus: null }, latestSuccess: null };

  it("enabled: today's rules (control): overdue, stuck", () => {
    expect(classifyJob("weekly-digest", overdue, now, { state: "enabled" }).freshness).toBe("overdue");
    expect(classifyJob("weekly-digest", stuckRun, now, { state: "enabled" }).stuck).toBe(true);
  });

  it("disabled: its own state, never overdue, stuck or 'fresh until'; the last run stays visible", () => {
    for (const reason of ["unset", "false"] as const) {
      const job = classifyJob("weekly-digest", overdue, now, { state: "disabled", reason });
      expect(job).toMatchObject({ freshness: "disabled", stuck: false, freshUntil: null, latestRun: overdue.latestRun });
      expect(classifyJob("weekly-digest", stuckRun, now, { state: "disabled", reason }).stuck).toBe(false);
      expect(classifyJob("weekly-digest", { latestRun: null, latestSuccess: null }, now, { state: "disabled", reason }).freshness).toBe("disabled");
    }
  });

  it("misconfigured: its own state, never reported as 'disabled' or 'on schedule'", () => {
    expect(classifyJob("weekly-digest", overdue, now, { state: "misconfigured" })).toMatchObject({ freshness: "misconfigured", stuck: false, freshUntil: null });
  });

  it("monthly-generation is classified identically whatever the digest switch says", () => {
    const enabled = classifyJob("monthly-generation", stuckRun, now, { state: "enabled" });
    expect(classifyJob("monthly-generation", stuckRun, now, { state: "disabled", reason: "unset" })).toEqual(enabled);
    expect(classifyJob("monthly-generation", stuckRun, now, { state: "misconfigured" })).toEqual(enabled);
  });
});
