import { mkdirSync } from "node:fs";
import path from "node:path";
import type { BrowserContext, Page } from "playwright-core";
import { onTestFailed } from "vitest";

/**
 * Diagnostics-only: wires a Playwright trace + screenshot into the CURRENTLY RUNNING vitest test
 * via onTestFailed. tests/browser/*.test.ts launch playwright-core directly (vitest.browser.config.ts
 * has no `browser:` block, so Vitest's own browser-mode trace/screenshot options don't apply) --
 * capture has to hook Playwright's own `context.tracing` API instead.
 *
 * Call once per BrowserContext/Page pair, from code running inside the `it(...)` body (directly or
 * via a helper it awaits) -- onTestFailed registers against whichever test is currently executing.
 * On a pass, nothing is ever stopped/saved: the trace stays open and is silently discarded when the
 * context closes (afterAll's `context.close()`) -- not explicitly stopped here, because Vitest 5 runs
 * onTestFinished callbacks BEFORE onTestFailed ones, so a "stop-if-not-saved" cleanup registered via
 * onTestFinished races the save below and intermittently stops tracing out from under it.
 */
const OUT_DIR = path.resolve(__dirname, "../../test-results/browser-failures");
let seq = 0;

/**
 * Exported so tests/browser/browser-failure-capture-sanitization.test.ts exercises the EXACT same
 * options production uses -- never a hand-copied duplicate that could silently drift from it.
 *
 * snapshots: true is shorthand for { dom: true }, which Playwright documents as capturing a DOM
 * snapshot on every action "and record[ing] network activity" -- that network recording embeds
 * real request/response headers (Cookie, Set-Cookie, Authorization) in trace.network, including
 * this suite's real signed session token (confirmed present with the old `snapshots: true` config,
 * confirmed absent -- trace.network empty, 0 bytes -- with this one). { screen: true } instead gives
 * a per-action screenshot (the actual visual diagnostic this capture exists for) with no DOM/network
 * recording bundled in.
 */
export const TRACING_START_OPTIONS = { screenshots: true, snapshots: { screen: true } } as const;

export function captureOnFailure(context: BrowserContext, page: Page, label = "page"): void {
  const tracingStarted = context.tracing.start(TRACING_START_OPTIONS);

  onTestFailed(async () => {
    await tracingStarted;
    mkdirSync(OUT_DIR, { recursive: true });
    const id = `${Date.now()}-${++seq}-${label.replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 60)}`;
    // Concise, non-sensitive warnings on save failure -- a broken capture must be visibly
    // distinguishable in the test log from "nothing failed, so nothing was written" (the normal
    // pass case). Logs only the error's own message/type, never page content or trace internals.
    await context.tracing
      .stop({ path: path.join(OUT_DIR, `${id}.trace.zip`) })
      .catch((err) => console.warn(`[browser-failure-capture] trace save failed for ${id}:`, err instanceof Error ? err.message : err));
    await page
      .screenshot({ path: path.join(OUT_DIR, `${id}.png`), fullPage: true })
      .catch((err) => console.warn(`[browser-failure-capture] screenshot save failed for ${id}:`, err instanceof Error ? err.message : err));
  });
}
