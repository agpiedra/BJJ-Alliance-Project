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

export function captureOnFailure(context: BrowserContext, page: Page, label = "page"): void {
  const tracingStarted = context.tracing.start({ screenshots: true, snapshots: true });

  onTestFailed(async () => {
    await tracingStarted;
    mkdirSync(OUT_DIR, { recursive: true });
    const id = `${Date.now()}-${++seq}-${label.replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 60)}`;
    await context.tracing.stop({ path: path.join(OUT_DIR, `${id}.trace.zip`) }).catch(() => {});
    await page.screenshot({ path: path.join(OUT_DIR, `${id}.png`), fullPage: true }).catch(() => {});
  });
}
