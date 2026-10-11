import "dotenv/config";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../src/lib/prisma";
import { SMOKE_BASE_URL, mintSessionCookie } from "../helpers/smoke";
import { TRACING_START_OPTIONS } from "../helpers/browser-failure-capture";

/**
 * Regression coverage for the browser-failure-capture sanitization fix: a Playwright trace started
 * with TRACING_START_OPTIONS (the exact options tests/browser/*.test.ts use via captureOnFailure)
 * must never embed a real session cookie/token, even though the page it traces is a real
 * authenticated page visited with a real signed session cookie.
 *
 * This exercises the real mechanism end to end (real browser, real auth, real trace.zip written to
 * disk, unzipped, and read back file by file) rather than asserting on the options object's shape,
 * because the earlier, unfixed config (`snapshots: true`) LOOKED reasonable and only the actual
 * extracted trace contents revealed the leak -- a shape-only check would not have caught that
 * originally and would not catch a regression that reintroduces it via some other option combination.
 */
let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch({ channel: "chrome", executablePath: process.env.BROWSER_EXECUTABLE_PATH || undefined, headless: true });
});

afterAll(async () => {
  await browser?.close();
  await prisma.$disconnect();
});

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

describe("browser-failure-capture: trace sanitization", () => {
  it("REQUIRED: a trace captured with TRACING_START_OPTIONS never contains the real session token used to authenticate the page it traced", async () => {
    const superAdmin = await prisma.user.findFirstOrThrow({ where: { email: "superadmin@alliancecr.com" }, select: { id: true } });
    const cookie = await mintSessionCookie(superAdmin.id);
    const token = cookie.slice(cookie.indexOf("=") + 1);

    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const [name, ...rest] = cookie.split("=");
    await context.addCookies([{ name, value: rest.join("="), url: SMOKE_BASE_URL }]);

    await context.tracing.start(TRACING_START_OPTIONS);
    const page = await context.newPage();
    await page.goto(`${SMOKE_BASE_URL}/en/platform`, { waitUntil: "networkidle" });
    await page.getByRole("link", { name: "Overview" }).click(); // an action, so the trace has something to capture (1280px desktop viewport: no mobile "Menu" trigger)

    const tmpDir = mkdtempSync(path.join(tmpdir(), "trace-sanitization-"));
    const zipPath = path.join(tmpDir, "trace.zip");
    const extractedDir = path.join(tmpDir, "extracted");
    try {
      await context.tracing.stop({ path: zipPath });
      await context.close();

      execFileSync("unzip", ["-o", zipPath, "-d", extractedDir], { stdio: "pipe" });

      const files = walk(extractedDir);
      expect(files.length, "the trace zip must extract to real entries, not be empty/corrupt").toBeGreaterThan(0);

      const offenders: string[] = [];
      for (const file of files) {
        const text = readFileSync(file).toString("latin1"); // byte-preserving; catches the token regardless of the file's real encoding
        if (text.includes(token) || text.includes("authjs.session-token")) offenders.push(path.relative(extractedDir, file));
      }
      expect(offenders, "no extracted trace file may contain the real session token or even the cookie's name").toEqual([]);

      // Prove this isn't passing by accident (e.g. tracing silently captured nothing): confirm the
      // visual diagnostics this capture exists for are actually present.
      const hasVisualFile = files.some((f) => {
        const rel = path.relative(extractedDir, f);
        return rel.startsWith(`screenshots${path.sep}`) || rel.startsWith(`screencast${path.sep}`);
      });
      expect(hasVisualFile, "sanitizing the trace must not also silently drop its visual diagnostics (screenshots/screencast)").toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
