import "dotenv/config";
import { execFileSync } from "node:child_process";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { resolveGuardedTestDatabaseUrl, testDatabaseChildEnv } from "../scripts/lib/test-database-guard";

// Every model table, truncated with CASCADE so FK order doesn't matter.
const TABLES = [
  "Notification",
  "AuditLog",
  "KioskAttempt",
  "PaymentPeriod",
  "PaymentPlan",
  "BeltRank",
  "PromotionConfig",
  "Promotion",
  "AttendanceRecord",
  "ClassSession",
  "PasswordResetToken",
  "StaffAssignment",
  "Student",
  "OrganizationMembership",
  "User",
  "Academy",
  "Organization",
];

async function truncateAll(databaseUrl: string): Promise<void> {
  const adapter = new PrismaPg({ connectionString: databaseUrl });
  const prisma = new PrismaClient({ adapter });
  const quoted = TABLES.map((t) => `"${t}"`).join(", ");
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${quoted} CASCADE;`);
  await prisma.$disconnect();
}

function runCommand(args: string[], databaseUrl: string): void {
  execFileSync("pnpm", args, {
    stdio: "inherit",
    env: testDatabaseChildEnv(databaseUrl),
    shell: process.platform === "win32",
  });
}

async function resetToSeed(): Promise<void> {
  const testUrl = resolveGuardedTestDatabaseUrl();
  // Migrate first — a new migration file (e.g. Phase 1's Organization
  // model) means the test database's tables may not exist yet even though
  // the dev database was already migrated by hand. Without this,
  // `pnpm test:integration` run on its own hits a bare TableDoesNotExist
  // instead of a clear error.
  runCommand(["exec", "prisma", "migrate", "deploy"], testUrl);
  await truncateAll(testUrl);
  runCommand(["exec", "prisma", "db", "seed"], testUrl);
}

/**
 * Vitest globalSetup — runs ONCE for the whole `pnpm test:integration`
 * invocation, not per file. Wipes the test database and reseeds the
 * deterministic fixture before any test runs, so every run starts from the
 * same known baseline regardless of what a previous run left behind; the
 * returned teardown does the same after the last test finishes, so nothing
 * a test created during the run (every existing fixture already uses a
 * uniquely generated name to avoid intra-run collisions) survives to make
 * the next run's — or a human's — inventory harder to read.
 */
export default async function setup() {
  await resetToSeed();
  return async function teardown() {
    await resetToSeed();
  };
}
