-- AlterTable
-- Two-step DDL, deliberately not the single-statement form Prisma's own diff
-- would generate for `brandingIsDefault Boolean @default(true)`: a single
-- `ADD COLUMN ... DEFAULT true` backfills EVERY EXISTING ROW to `true` too,
-- which would make every organization that already has stored colors read
-- as "no data of its own yet" and silently discard them in favor of the
-- shared MATROOM default palette. Existing rows must preserve their current
-- stored-color/null-override behavior; only rows created AFTER this
-- migration should start in default mode.
--
-- Step 1: add the column with a literal default of `false` — Postgres
-- backfills this into every row that already exists, which is exactly the
-- "read my own stored columns, as today" value this plan needs for them
-- (not a claim about whether anyone customized those colors; their
-- customization intent is unknown and not inferred here).
ALTER TABLE "OrganizationBranding" ADD COLUMN "brandingIsDefault" BOOLEAN NOT NULL DEFAULT false;

-- Step 2: change the column's default for FUTURE inserts only — this never
-- rewrites any row that already exists (Postgres's ALTER COLUMN SET DEFAULT
-- semantics). A row seedOrganizationDefaults() creates after this migration
-- gets `true` with no call-site change, same pattern as every other default
-- in this table.
ALTER TABLE "OrganizationBranding" ALTER COLUMN "brandingIsDefault" SET DEFAULT true;

-- Defense-in-depth only (see this column's own schema doc comment): these
-- two literal defaults are never actually read while brandingIsDefault is
-- true, but are updated anyway in case a future code path ever reads the
-- row directly without checking that flag.
ALTER TABLE "OrganizationBranding" ALTER COLUMN "primaryColor" SET DEFAULT '#254b35';
ALTER TABLE "OrganizationBranding" ALTER COLUMN "sidebarBackground" SET DEFAULT '#fffefa';
