import { Pool } from "pg";
import { attachDatabasePool } from "@vercel/functions";
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { requireEnv } from "@/lib/env";

const globalForPrisma = globalThis as unknown as {
  unscopedPrisma: PrismaClient | undefined;
};

/**
 * Built for a DATABASE_URL that points at a transaction-mode pooler in
 * production (docs/DEPLOYMENT_RUNBOOK.md). Verified against the real
 * adapter and a real PgBouncer in transaction mode, not assumed:
 *
 * - No `?pgbouncer=true`: that's a Prisma *engine* parameter. This adapter
 *   hands the URL to node-postgres, which stores it as an inert key and
 *   never sends it.
 * - Never pass `statementNameGenerator`: without it this adapter creates no
 *   named prepared statements (0 in `pg_prepared_statements`), which is what
 *   makes transaction pooling safe. Opting in fails 110 of 120 concurrent
 *   queries with `42P05 prepared statement already exists`
 *   (tests/integration/no-named-prepared-statements.test.ts pins this).
 * - `idleTimeoutMillis: 5000` + `attachDatabasePool`: Vercel's guidance for
 *   pg on Fluid compute — idle connections close before an instance
 *   suspends. `attachDatabasePool` is inert off Vercel. Don't cap `max` at 1
 *   (Vercel: it harms concurrency without reducing connections).
 * - `disposeExternalPool`: the pool is ours, so `$disconnect()` must end it.
 */
function buildUnscopedClient(): PrismaClient {
  const pool = new Pool({ connectionString: requireEnv("DATABASE_URL"), idleTimeoutMillis: 5_000 });
  attachDatabasePool(pool);
  return new PrismaClient({ adapter: new PrismaPg(pool, { disposeExternalPool: true }) });
}

/**
 * The ONE real, unguarded Prisma client in this codebase. Revision 23
 * (docs/MULTI_ACADEMY_AND_KIDS_BELTS.md): the base client used to be
 * `@/lib/prisma`'s own export, which meant the "obvious" import was the
 * unsafe one — `src/app/[locale]/(staff)/layout.tsx` and
 * `src/app/[locale]/signup/page.tsx` both reached for it without noticing,
 * and leaked every organization's academy names across tenants. Now the
 * unsafe client has an unmistakable name and its own module, and
 * `@/lib/prisma`'s export is the guarded one instead — right is what you
 * get by default; wrong requires typing this exact import.
 *
 * `prisma/seed.ts` does NOT import this module — it constructs its own,
 * fully separate `PrismaClient` behind its own `assertSafeSeedTarget()`
 * safety check, and was already structurally independent of `@/lib/prisma`
 * before this revision. It needs no migration and is not on the allowlist
 * below.
 *
 * ESLint's `no-restricted-imports` is MEANT to ban importing this module
 * outside an explicit allowlist, but `eslint.config.mjs` is hard-blocked by
 * this repo's config-protection hook — it must be applied BY HAND. Paste
 * this into `eslint.config.mjs` (replacing its current single-item
 * `eslintConfig` array):
 *
 * ```js
 * const eslintConfig = [
 *   ...compat.extends("next/core-web-vitals", "next/typescript"),
 *   {
 *     ignores: ["node_modules/**", ".next/**", "out/**", "build/**", "next-env.d.ts"],
 *   },
 *   {
 *     rules: {
 *       "no-restricted-imports": [
 *         "error",
 *         {
 *           paths: [
 *             {
 *               name: "@/lib/prisma/unscoped",
 *               message:
 *                 "Importing unscopedPrisma bypasses tenant scoping entirely. If this call site is genuinely platform-level, add it to the allowlist in eslint.config.mjs with a one-line reason — never import it silently.",
 *             },
 *           ],
 *         },
 *       ],
 *     },
 *   },
 *   {
 *     // Allowlist: every file below has a one-line reason next to its own
 *     // `unscopedPrisma` import explaining why it's a legitimate hatch.
 *     // Keep this list and those comments in sync — add both together.
 *     files: [
 *       "src/lib/prisma.ts",
 *       "src/lib/tenant/scoped-client.ts",
 *       "src/app/api/cron/weekly-digest/route.ts",
 *       "src/lib/notifications/weekly-digest.ts",
 *       "src/lib/notifications/recipients.ts",
 *       "src/app/[locale]/kiosk/[academySlug]/page.tsx",
 *       "src/app/api/kiosk/check-in/route.ts",
 *       "src/app/api/kiosk/reassign/route.ts",
 *       "src/app/[locale]/signup/page.tsx",
 *       "src/app/[locale]/signup/actions.ts",
 *     ],
 *     rules: { "no-restricted-imports": "off" },
 *   },
 * ];
 * ```
 *
 * Those 10 files are the ONLY legitimate reasons to bypass tenant scoping as
 * of this PR: `@/lib/prisma`'s own construction of the guarded client,
 * `getScopedDb`'s implementation (it builds the real scoping extension from
 * this), the weekly-digest cron's per-organization iteration and its
 * per-academy digest sender, `recipients.ts`'s academy-identity resolution
 * (shared by both notify-* triggers and the digest), the kiosk's
 * slug-to-organization resolution (which can't be scoped by the
 * organization it's trying to discover), and signup's page + action (public,
 * pre-auth, both restricted to Alliance's two hardcoded academy slugs).
 */
export const unscopedPrisma = globalForPrisma.unscopedPrisma ?? buildUnscopedClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.unscopedPrisma = unscopedPrisma;
}
