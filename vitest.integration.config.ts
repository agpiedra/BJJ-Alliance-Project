import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// See vitest.config.ts's own comment on this exact line for the full
// reasoning — same hostile zone, same reason it must be set here (main
// process, before worker pools start) rather than via `test.env`.
process.env.TZ = "Pacific/Kiritimati";

/**
 * Separate from vitest.config.ts (used by `pnpm test:unit`, which never
 * touches a database and must not require TEST_DATABASE_URL) specifically so
 * the test-database guard and reset/reseed machinery only run for
 * `pnpm test:integration`. Duplicates the base config's plugin/resolve
 * settings rather than merging with it — vitest/vite's array-merge semantics
 * for `setupFiles` aren't worth depending on here.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    // A bare `npx vitest run --config vitest.integration.config.ts` (no path
    // argument) must never silently widen scope to tests/unit/** — that
    // exact omission combined 270 unit tests into what got reported as "the
    // integration suite" this session, a false-green failure shape.  Same
    // reasoning as check:guard-usage: a check here, not reliance on always
    // remembering to pass the right path.
    include: ["tests/integration/**/*.test.{ts,tsx}"],
    exclude: ["**/node_modules/**", "tests/unit/**"],
    setupFiles: ["./tests/setup.ts", "./tests/integration-setup.ts"],
    globalSetup: ["./tests/integration-global-setup.ts"],
    // seed-repairs-drift.test.ts deliberately writes a wrong value directly
    // into a real seed-owned row (e.g. the WHITE belt rank's stripeColors)
    // before reseeding to prove the repair — any other file that reads that
    // same row while it's briefly wrong races against it. Confirmed: with
    // file-level parallelism on, perform-check-in.test.ts (which hardcodes
    // WHITE-rank color assertions) failed only when run alongside the drift
    // test, and passed every time in isolation. Every integration test
    // shares one physical test database with no per-file transaction
    // isolation, so this is the only way to guarantee no file ever observes
    // another file's fixture mid-mutation.
    fileParallelism: false,
    environment: "node",
    server: {
      deps: { inline: ["next-auth"] },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "next/server": path.resolve(__dirname, "./node_modules/next/server.js"),
    },
  },
});
