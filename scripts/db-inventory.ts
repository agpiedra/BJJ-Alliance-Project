/**
 * Read-only inventory of a database's row counts and who/what created them —
 * promoted from a one-off diagnostic (used for the Phase 0 dev-database
 * cleanup, docs/MULTI_ACADEMY_AND_KIDS_BELTS.md) into a permanent tool for
 * re-running after future phases.
 *
 * Requires an explicit --database-url flag; never reads DATABASE_URL as a
 * fallback. Read-only: enforced via scripts/lib/read-only-transaction.ts's
 * runReadOnly() — the same helper scripts/alliance-baseline.ts uses.
 *
 * Usage: pnpm db:inventory -- --database-url="postgres://...
 */
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { runReadOnly } from "./lib/read-only-transaction";

// Domains a legitimate row is expected to carry: real Alliance staff/QA
// accounts, and the deterministic seed's fixture domain (prisma/seed.ts).
// Anything else on a User/Student row is unexpected and worth investigating
// by hand, the same way the original 2026-09-12 fixture pollution was found.
const KNOWN_DOMAINS = ["@alliancecr.com", "@test.com", "@fixture.internal"];

function resolveDatabaseUrl(): string {
  const flag = process.argv.find((arg) => arg.startsWith("--database-url="));
  const url = flag?.slice("--database-url=".length);
  if (!url) throw new Error("Missing --database-url=<connection-string>. DATABASE_URL is never read implicitly.");
  return url;
}

function isKnownEmail(email: string): boolean {
  return KNOWN_DOMAINS.some((domain) => email.endsWith(domain));
}

function dayBucket(date: Date): string {
  return date.toISOString().slice(0, 10);
}

async function main() {
  const databaseUrl = resolveDatabaseUrl();
  const adapter = new PrismaPg({ connectionString: databaseUrl });
  const prisma = new PrismaClient({ adapter });

  await runReadOnly(prisma, async (tx) => {
      console.log("Read-only transaction verified (transaction_read_only = on).\n");

      const counts = {
        Academy: await tx.academy.count(),
        User: await tx.user.count(),
        StaffAssignment: await tx.staffAssignment.count(),
        Student: await tx.student.count(),
        ClassSession: await tx.classSession.count(),
        AttendanceRecord: await tx.attendanceRecord.count(),
        Promotion: await tx.promotion.count(),
        BeltRank: await tx.beltRank.count(),
        PromotionConfig: await tx.promotionConfig.count(),
        PaymentPlan: await tx.paymentPlan.count(),
        PaymentPeriod: await tx.paymentPeriod.count(),
        KioskAttempt: await tx.kioskAttempt.count(),
        AuditLog: await tx.auditLog.count(),
        Notification: await tx.notification.count(),
        PasswordResetToken: await tx.passwordResetToken.count(),
      };
      console.log("=== Row counts per model ===");
      console.log(JSON.stringify(counts, null, 2));

      console.log("\n=== Academies (all rows) ===");
      const academies = await tx.academy.findMany({
        select: { id: true, name: true, slug: true, active: true, createdAt: true },
        orderBy: { createdAt: "asc" },
      });
      for (const a of academies) {
        console.log(`${a.createdAt.toISOString()}  ${a.slug.padEnd(20)} "${a.name}"  active=${a.active}`);
      }

      console.log("\n=== Users: known vs. unexpected domains ===");
      const users = await tx.user.findMany({ select: { id: true, email: true, role: true, createdAt: true, active: true } });
      const unexpectedUsers = users.filter((u) => !isKnownEmail(u.email));
      console.log(`Total: ${users.length} | known-domain: ${users.length - unexpectedUsers.length} | unexpected: ${unexpectedUsers.length}`);
      if (unexpectedUsers.length > 0) {
        console.log("Unexpected users — review individually:");
        for (const u of unexpectedUsers.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
          console.log(`  ${u.createdAt.toISOString()}  ${u.email.padEnd(35)} role=${u.role.padEnd(10)} active=${u.active}`);
        }
      }

      console.log("\n=== Students: known vs. unexpected domains ===");
      const students = await tx.student.findMany({
        select: { id: true, email: true, firstName: true, lastName: true, homeAcademyId: true, createdAt: true, status: true },
      });
      const unexpectedStudents = students.filter((s) => !isKnownEmail(s.email));
      console.log(`Total: ${students.length} | known-domain: ${students.length - unexpectedStudents.length} | unexpected: ${unexpectedStudents.length}`);
      if (unexpectedStudents.length > 0) {
        console.log("Unexpected students — review individually:");
        for (const s of unexpectedStudents.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
          console.log(`  ${s.createdAt.toISOString()}  ${s.firstName} ${s.lastName} <${s.email}>  status=${s.status}`);
        }
      }

      console.log("\n=== Row-count-only tables, by creation day ===");
      const auditByDay = new Map<string, number>();
      for (const row of await tx.auditLog.findMany({ select: { createdAt: true } })) {
        auditByDay.set(dayBucket(row.createdAt), (auditByDay.get(dayBucket(row.createdAt)) ?? 0) + 1);
      }
      console.log("AuditLog by day:", Object.fromEntries([...auditByDay.entries()].sort()));

      const notifByDay = new Map<string, number>();
      for (const row of await tx.notification.findMany({ select: { createdAt: true } })) {
        notifByDay.set(dayBucket(row.createdAt), (notifByDay.get(dayBucket(row.createdAt)) ?? 0) + 1);
      }
      console.log("Notification by day:", Object.fromEntries([...notifByDay.entries()].sort()));
  });

  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
