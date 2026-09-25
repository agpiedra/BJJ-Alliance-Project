import path from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Rendered-browser tests (tests/browser): real Chrome, driven by playwright-core, against an ALREADY-RUNNING app (`pnpm dev`,
 * the same way the smoke suite works and with the same localhost-only SMOKE_BASE_URL guard). They exist for what jsdom and
 * class-name assertions cannot see: laid-out sizes, and whether content fits inside its control, under a mouse pointer and a
 * coarse (touch) pointer. Browser: the system Chrome (`channel: "chrome"`, present on GitHub's ubuntu runners); set
 * BROWSER_EXECUTABLE_PATH to use another Chromium-based binary. There is no silent skip: a missing browser fails the run.
 */
export default defineConfig({
  test: {
    include: ["tests/browser/**/*.test.ts"],
    exclude: ["**/node_modules/**"],
    environment: "node",
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
