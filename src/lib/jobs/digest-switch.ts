/**
 * Per-environment switch for the weekly digest (docs/dues/WEEKLY-DIGEST-SWITCH-PROPOSAL.md, owner-approved 2026-11-17).
 *
 * `WEEKLY_DIGEST_ENABLED` (surrounding spaces ignored):
 * - exactly `true`: enabled, the digest runs as before;
 * - unset, empty or exactly `false`: intentionally disabled (the default: no environment sends digests until it opts in);
 * - anything else (`TRUE`, `yes`, `1`, ...): misconfigured. The digest still does nothing (fail closed), and health reports
 *   a configuration error, never "disabled".
 */
export type DigestSwitch = { state: "enabled" } | { state: "disabled"; reason: "unset" | "false" } | { state: "misconfigured" };

export function digestSwitch(env: Record<string, string | undefined> = process.env): DigestSwitch {
  const value = env.WEEKLY_DIGEST_ENABLED?.trim();
  if (!value) return { state: "disabled", reason: "unset" };
  if (value === "true") return { state: "enabled" };
  if (value === "false") return { state: "disabled", reason: "false" };
  return { state: "misconfigured" };
}
