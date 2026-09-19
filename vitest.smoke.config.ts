import path from "node:path";
import { defineConfig } from "vitest/config";

// See vitest.config.ts's own comment on this exact line for the full
// reasoning. Note this only hostile-zones the test-runner process itself —
// the app server this suite hits (started separately, e.g. `pnpm dev`)
// keeps whatever TZ launched it in. That's fine today (this suite asserts
// HTTP status codes, not dates), but is a real limit if a smoke test ever
// needs to assert date-dependent rendered content.
process.env.TZ = "Pacific/Kiritimati";

/**
 * Separate from both vitest.config.ts and vitest.integration.config.ts:
 * this suite makes real HTTP requests against an ALREADY-RUNNING `next
 * start`/`next dev` process (started by CI or by hand — see package.json's
 * `test:smoke` comment) rather than exercising app code in-process. No
 * jsdom, no Next.js request-context mocking, no `unstable_cache`-style
 * incompatibilities to route around — just `fetch()` against SMOKE_BASE_URL.
 *
 * Existential reason this file exists at all: docs/MULTI_ACADEMY_AND_KIDS_BELTS.md's
 * "a guard is not tested until something takes the unguarded path" rule,
 * extended past guards to pages themselves — every other suite in this repo
 * constructs contexts or mocks `auth()` directly, so a page that throws
 * during real Next.js SSR (the actual rowFor() bug this suite exists to
 * catch permanently) was invisible to all 445 previously-green tests.
 */
export default defineConfig({
  test: {
    include: ["tests/smoke/**/*.test.ts"],
    exclude: ["**/node_modules/**"],
    environment: "node",
    // Real HTTP round-trips against a real server, sequential is plenty
    // fast and keeps failure output attributable to one route at a time.
    fileParallelism: false,
    testTimeout: 30_000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
