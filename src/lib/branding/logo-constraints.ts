/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 4 — logo upload constraints, split
 * out of validate-logo.ts specifically so this file has NO `sharp` import
 * (a Node-only native module) and can be imported from a client component
 * (logo-uploader.tsx) as well as the server-side validator.
 *
 * These are the single source of truth: validate-logo.ts imports them
 * rather than redeclaring them, so the client-side pre-check and the real
 * server-side rule can never drift apart.
 */
export const ACCEPTED_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export const MAX_LOGO_BYTES = 512 * 1024;
export const MAX_LOGO_DIMENSION = 1024;
/** Beyond this, `object-contain` alone can't rescue legibility — a 2000x50
 * wordmark would render illegibly tiny inside any nav-icon-sized slot. Below
 * it, a wide/tall logo just renders smaller within its slot, never rejected:
 * most real gym wordmarks are well inside this. */
export const MAX_ASPECT_RATIO = 5;
