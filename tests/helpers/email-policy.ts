import { vi } from "vitest";

/**
 * The actual staging deployment's configuration (docs/EMAIL_RECIPIENT_POLICY.md): Vercel reports its live deployment as
 * a "production" target, and the recipient policy restricts it to an allowlist. Undo with `vi.unstubAllEnvs()`.
 */
export function stubStagingEmailPolicy(...allowed: string[]): void {
  vi.stubEnv("VERCEL_ENV", "production");
  vi.stubEnv("EMAIL_DELIVERY_MODE", "allowlist");
  vi.stubEnv("EMAIL_RECIPIENT_ALLOWLIST", allowed.join(","));
}

/** Production's configuration: unrestricted, no allowlist. For tests that send to generated addresses through a real path. */
export function stubProductionEmailPolicy(): void {
  vi.stubEnv("VERCEL_ENV", "production");
  vi.stubEnv("EMAIL_DELIVERY_MODE", "unrestricted");
  vi.stubEnv("EMAIL_RECIPIENT_ALLOWLIST", undefined);
}
