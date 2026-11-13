import { createHmac } from "node:crypto";

/**
 * Fail-closed recipient policy for every email this app sends (docs/EMAIL_RECIPIENT_POLICY.md). Both send paths —
 * `sendTransactionalEmail` and the notification `EmailChannel` — call `checkRecipient` before anything reaches Resend.
 *
 * EMAIL_DELIVERY_MODE must be exactly `allowlist` or `unrestricted` (surrounding spaces ignored). Anything else, or
 * missing, blocks every send. `allowlist` needs EMAIL_RECIPIENT_ALLOWLIST: comma-separated exact addresses, at most
 * MAX_ALLOWLIST_ENTRIES; a missing, empty or invalid list blocks every send — one bad entry rejects the whole list.
 *
 * `unrestricted` is honored only when VERCEL_ENV is "production" and no allowlist is set. VERCEL_ENV is a Vercel
 * DEPLOYMENT TARGET, not a staging/production boundary: the staging project's live deployment is also a "production"
 * target. That check only keeps preview, development and local runs from sending freely. Staging stays restricted
 * because its own configuration says `allowlist` — opening it takes two deliberate settings changes (mode to
 * `unrestricted` AND removing the allowlist); either alone blocks every send. The status route reports which applies.
 */

export const MAX_ALLOWLIST_ENTRIES = 25;

export type PolicyBlockReason =
  | "mode_invalid"
  | "allowlist_missing"
  | "allowlist_invalid"
  | "mode_conflict"
  | "unrestricted_outside_production"
  | "not_allowlisted";

type Env = Readonly<Record<string, string | undefined>>;

export type EmailPolicy =
  | { effective: "allowlist"; addresses: ReadonlySet<string> }
  | { effective: "unrestricted" }
  | { effective: "blocked_all"; reason: Exclude<PolicyBlockReason, "not_allowlisted"> };

// Plain addresses only: no display names, spaces, wildcards, separators or bare domains.
const ADDRESS = /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/;

function parseAllowlist(raw: string | undefined): EmailPolicy {
  if (raw === undefined || raw.trim() === "") return { effective: "blocked_all", reason: "allowlist_missing" };
  const entries = raw.split(",").map((entry) => entry.trim().toLowerCase());
  if (entries.length > MAX_ALLOWLIST_ENTRIES || entries.some((entry) => !ADDRESS.test(entry))) {
    return { effective: "blocked_all", reason: "allowlist_invalid" };
  }
  return { effective: "allowlist", addresses: new Set(entries) };
}

export function resolveEmailPolicy(env: Env = process.env): EmailPolicy {
  const mode = env.EMAIL_DELIVERY_MODE?.trim();
  if (mode === "allowlist") return parseAllowlist(env.EMAIL_RECIPIENT_ALLOWLIST);
  if (mode === "unrestricted") {
    if (env.EMAIL_RECIPIENT_ALLOWLIST !== undefined) return { effective: "blocked_all", reason: "mode_conflict" };
    if (env.VERCEL_ENV !== "production") return { effective: "blocked_all", reason: "unrestricted_outside_production" };
    return { effective: "unrestricted" };
  }
  return { effective: "blocked_all", reason: "mode_invalid" };
}

/** Whether one send to `to` may proceed. Allowlist matching is exact and case-insensitive; `to` is never trimmed. */
export function checkRecipient(to: string, env: Env = process.env): { allowed: true } | { allowed: false; reason: PolicyBlockReason } {
  const policy = resolveEmailPolicy(env);
  if (policy.effective === "unrestricted") return { allowed: true };
  if (policy.effective === "blocked_all") return { allowed: false, reason: policy.reason };
  return policy.addresses.has(to.toLowerCase()) ? { allowed: true } : { allowed: false, reason: "not_allowlisted" };
}

export interface EmailPolicyStatus {
  mode: "allowlist" | "unrestricted" | "invalid";
  effective: EmailPolicy["effective"];
  reason: Exclude<PolicyBlockReason, "not_allowlisted"> | null;
  deploymentTarget: "production" | "preview" | "development" | "other";
  allowlistCount: number | null;
  /** HMAC-SHA256 (key: the status route's secret) over the sorted unique addresses joined by "\n"; null unless allowlist is effective. */
  allowlistFingerprint: string | null;
  providerKeyPresent: boolean;
  senderConfigured: boolean;
}

/**
 * Diagnostic summary for the authenticated status route. Never contains an address, a domain, a key or any raw
 * setting value: modes and targets are mapped to fixed values, the list only to a count and a keyed fingerprint.
 */
export function emailPolicyStatus(fingerprintKey: string, env: Env = process.env): EmailPolicyStatus {
  const policy = resolveEmailPolicy(env);
  const rawMode = env.EMAIL_DELIVERY_MODE?.trim();
  const target = env.VERCEL_ENV;
  const addresses = policy.effective === "allowlist" ? [...policy.addresses].sort() : null;
  return {
    mode: rawMode === "allowlist" || rawMode === "unrestricted" ? rawMode : "invalid",
    effective: policy.effective,
    reason: policy.effective === "blocked_all" ? policy.reason : null,
    deploymentTarget: target === "production" || target === "preview" || target === "development" ? target : "other",
    allowlistCount: addresses ? addresses.length : null,
    allowlistFingerprint: addresses ? allowlistFingerprint(addresses, fingerprintKey) : null,
    providerKeyPresent: Boolean(env.RESEND_API_KEY?.trim()),
    senderConfigured: Boolean(env.EMAIL_FROM?.trim()),
  };
}

export function allowlistFingerprint(sortedUniqueAddresses: readonly string[], key: string): string {
  return createHmac("sha256", key).update(sortedUniqueAddresses.join("\n")).digest("hex");
}
