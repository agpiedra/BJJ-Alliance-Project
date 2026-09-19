import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Deliberately hostile to every timezone this codebase actually seeds
// (Central America, UTC-6, no DST) — a test that passes only because the
// machine running it happens to share an offset with the fixture data is
// agreeing with its environment, not asserting anything. UTC-only isn't
// enough: it's just 6 hours off and shares a date boundary with UTC-6 far
// too often to catch calendar-date bugs. Pacific/Kiritimati (UTC+14) is 20
// hours away and almost never on the same calendar date. Per Vitest's own
// docs (docs/guide/common-errors.md "Time Zone Does Not Change in Worker
// Threads"), TZ must be set here, in the main process before worker pools
// start — `test.env` has no effect under the default `pool: 'threads'`.
process.env.TZ = "Pacific/Kiritimati";

export default defineConfig({
  plugins: [react()],
  test: {
    // A bare `npx vitest run --config vitest.config.ts` (no path argument)
    // must never silently widen scope to tests/integration/** — that
    // combined a suite of 270 unit tests with the integration suite under
    // one misleading "green" report this session (root-caused: the missing
    // path argument let vitest's default include glob scan the whole repo).
    // Same reasoning as check:guard-usage: a check here, not reliance on
    // always remembering to pass the right path.
    include: ["tests/unit/**/*.test.{ts,tsx}"],
    exclude: ["**/node_modules/**", "tests/integration/**"],
    setupFiles: ["./tests/setup.ts"],
    environment: "node",
    server: {
      // Force next-auth through Vite's own resolver (which honors the
      // "next/server" alias below) instead of Node's native ESM loader —
      // see the alias comment for why the bare import otherwise fails.
      deps: { inline: ["next-auth"] },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // next-auth's compiled ESM does `import ... from "next/server"` with no
      // extension. Next's package.json has no "exports" map, so strict Node/Vite
      // ESM resolution can't find it (works fine inside Next's own bundler,
      // which is more permissive). Point it straight at the real file.
      "next/server": path.resolve(__dirname, "./node_modules/next/server.js"),
    },
  },
});
