/**
 * docs/PROMOTION_PROGRESS_PROPOSAL.md - moves an EXISTING organization onto the
 * academy's decided promotion accounting (one qualifying attendance per Costa Rica
 * day, progress resets to 0 at every award, no head-start credits, time-based black
 * belt). A new organization starts on it already; an existing one has history the
 * change reinterprets, so this is a deliberate two-step, reviewed operation:
 *
 *   1. REPORT (read-only, writes nothing) - who is affected and how:
 *        pnpm promotion:accounting report --org=<slug> [--out=<file.json>]
 *      It prints a summary and a `reportId`. Review it: in particular the students who
 *      are eligible TODAY and will read 0 after activation.
 *
 *   2. ACTIVATE - dry run by default; --apply writes, and only with the reportId of a
 *      report that is still true (the data moved since = the id no longer matches):
 *        pnpm promotion:accounting activate --org=<slug> --report=<reportId> --activated-by=<email>
 *        pnpm promotion:accounting activate --org=<slug> --report=<reportId> --activated-by=<email> --apply
 *
 * It uses DATABASE_URL, so check the target printed on the first line. It never
 * edits attendance, promotions, credits or the historical belt date, and never
 * invents a promotion: every student gets a system tracking baseline at the
 * activation instant. See src/lib/promotion/accounting-activation.ts.
 */
import "dotenv/config";
import { writeFileSync } from "node:fs";
import { prisma } from "../src/lib/prisma";
import { activateAccounting, buildImpactReport } from "../src/lib/promotion/accounting-activation";

function flag(name: string): string | undefined {
  const found = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return found?.slice(`--${name}=`.length);
}

/** Host/port/db only - never the credentials. */
function redactedTarget(): string {
  try {
    const url = new URL(process.env.DATABASE_URL ?? "");
    return `${url.hostname}:${url.port || "5432"}${url.pathname}`;
  } catch {
    return "(DATABASE_URL is not set or not a URL)";
  }
}

async function main() {
  const command = process.argv[2];
  const org = flag("org");
  console.log(`promotion-accounting: target database ${redactedTarget()}`);

  if (!org || (command !== "report" && command !== "activate")) {
    console.error(
      "Usage:\n  tsx scripts/promotion-accounting.ts report --org=<slug> [--out=<file.json>]\n" +
        "  tsx scripts/promotion-accounting.ts activate --org=<slug> --report=<id> --activated-by=<email> [--apply]",
    );
    process.exit(1);
  }

  const report = await buildImpactReport(prisma, org);

  if (command === "report") {
    const out = flag("out");
    if (out) writeFileSync(out, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ reportId: report.reportId, tracks: report.tracks, blackBeltCatalog: report.blackBeltCatalog, totals: report.totals }, null, 2));
    const eligible = report.students.filter((s) => s.today.eligible);
    console.log(`\nEligible for review TODAY and reading 0 after activation (${eligible.length}):`);
    for (const s of eligible) console.log(`  ${s.studentId}  ${s.track} ${s.rank}/${s.stripes}  ${s.today.count}${s.today.target ? `/${s.today.target}` : ""}`);
    if (out) console.log(`\nFull per-student report written to ${out}`);
    console.log(`\nreportId: ${report.reportId}   (nothing was changed)`);
    return;
  }

  const reportId = flag("report");
  const email = flag("activated-by");
  if (!reportId || !email) {
    console.error("activate needs --report=<id> (from a report you reviewed) and --activated-by=<email>.");
    process.exit(1);
  }
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (!user) {
    console.error(`No user with email ${email}.`);
    process.exit(1);
  }
  if (report.reportId !== reportId) {
    console.error(`The report has changed since the one you reviewed (now ${report.reportId}, you passed ${reportId}). Re-run report, review it, and try again. Nothing was changed.`);
    process.exit(2);
  }
  if (!process.argv.includes("--apply")) {
    console.log(
      `DRY RUN - would set ${report.tracks.length} track(s) to PER_INTERVAL, record a tracking baseline for ${report.totals.students} student(s)` +
        `${report.blackBeltCatalog?.needsUpdate ? ", and complete the black-belt catalog" : ""}. ${report.totals.eligibleTodayResettingToZero} eligible student(s) will read 0. Add --apply to write.`,
    );
    return;
  }
  const result = await activateAccounting(prisma, { organizationSlug: org, reportId, activatedByUserId: user.id });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exit(2);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
