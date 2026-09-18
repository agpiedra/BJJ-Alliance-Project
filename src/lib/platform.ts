/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md — the platform's own name, shown wherever
 * there is no organization to name instead: genuinely pre-tenant pages
 * (login, register-academy, accept-invitation, forgot/reset-password, the
 * unavailable/no-access/select-organization pages, the marketing home) and
 * the browser-tab `<title>`/PWA manifest, which are global and can never be
 * per-organization. No real product name has been chosen yet.
 *
 * This is the ONE place that changes when it is. Every other file that
 * needs the platform's name imports this constant — never a second
 * hardcoded copy, and never Alliance's own name, which belongs only to
 * Alliance's own organization (its real name lives in the Organization row
 * `getOrganizationBranding` already resolves).
 */
export const PLATFORM_NAME = "[Platform name TBD]";
