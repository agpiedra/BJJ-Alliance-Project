-- Stage 9, PR 9-1: the activation record (docs/dues/STAGE-9-IMPLEMENTATION-PLAN.md, A1).
-- One explicit transaction: Prisma's `migrate deploy` does not wrap a migration file (verified for O4), so a failing
-- statement must not leave earlier ones applied.
-- Nothing in the application writes this table in PR 9-1; every organization stays inactive.
BEGIN;

CREATE TABLE "DuesActivation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "startYear" INTEGER NOT NULL,
    "startMonth" INTEGER NOT NULL,
    "fingerprintFormat" TEXT NOT NULL,
    "configFingerprint" TEXT NOT NULL,
    "studentFingerprints" JSONB NOT NULL,
    "approvedById" TEXT NOT NULL,
    "approvedAt" TIMESTAMP(3) NOT NULL,
    "withdrawnAt" TIMESTAMP(3),
    "withdrawnById" TEXT,
    "effectiveAt" TIMESTAMP(3),
    "effectiveById" TEXT,

    CONSTRAINT "DuesActivation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "DuesActivation_start_month_valid" CHECK ("startMonth" BETWEEN 1 AND 12 AND "startYear" BETWEEN 2000 AND 2100),
    CONSTRAINT "DuesActivation_fingerprints_present" CHECK (
      btrim("fingerprintFormat") <> '' AND btrim("configFingerprint") <> '' AND jsonb_typeof("studentFingerprints") = 'object'
    ),
    -- Each marker is a complete pair; a row is withdrawn or effective, never both.
    CONSTRAINT "DuesActivation_withdrawal_complete" CHECK (("withdrawnAt" IS NULL) = ("withdrawnById" IS NULL)),
    CONSTRAINT "DuesActivation_effective_complete" CHECK (("effectiveAt" IS NULL) = ("effectiveById" IS NULL)),
    CONSTRAINT "DuesActivation_not_withdrawn_and_effective" CHECK ("withdrawnAt" IS NULL OR "effectiveAt" IS NULL)
);

CREATE INDEX "DuesActivation_organizationId_idx" ON "DuesActivation"("organizationId");

-- At most one live (not withdrawn) row per organization. An effective row is live forever (it can never be withdrawn), so
-- this also means: at most one effective row, and no new approval after activation.
CREATE UNIQUE INDEX "DuesActivation_one_live_per_organization" ON "DuesActivation"("organizationId") WHERE "withdrawnAt" IS NULL;

ALTER TABLE "DuesActivation" ADD CONSTRAINT "DuesActivation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DuesActivation" ADD CONSTRAINT "DuesActivation_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DuesActivation" ADD CONSTRAINT "DuesActivation_withdrawnById_fkey" FOREIGN KEY ("withdrawnById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DuesActivation" ADD CONSTRAINT "DuesActivation_effectiveById_fkey" FOREIGN KEY ("effectiveById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Set once: the approval columns never change; each marker pair goes from unset to set once and then never changes.
CREATE FUNCTION dues_activation_set_once() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  markers text[] := ARRAY['withdrawnAt', 'withdrawnById', 'effectiveAt', 'effectiveById'];
BEGIN
  IF (to_jsonb(NEW) - markers) IS DISTINCT FROM (to_jsonb(OLD) - markers) THEN
    RAISE EXCEPTION 'dues_activation: the approval is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD."withdrawnAt" IS NOT NULL AND (NEW."withdrawnAt", NEW."withdrawnById") IS DISTINCT FROM (OLD."withdrawnAt", OLD."withdrawnById") THEN
    RAISE EXCEPTION 'dues_activation: the withdrawal is already set' USING ERRCODE = '23514';
  END IF;
  IF OLD."effectiveAt" IS NOT NULL AND (NEW."effectiveAt", NEW."effectiveById") IS DISTINCT FROM (OLD."effectiveAt", OLD."effectiveById") THEN
    RAISE EXCEPTION 'dues_activation: the activation is already effective' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "DuesActivation_set_once" BEFORE UPDATE ON "DuesActivation" FOR EACH ROW EXECUTE FUNCTION dues_activation_set_once();
-- Born approved only: reuses O4's marker-absent function (migration 20261110120000).
CREATE TRIGGER "DuesActivation_no_marker_on_insert" BEFORE INSERT ON "DuesActivation" FOR EACH ROW
  EXECUTE FUNCTION dues_marker_absent_on_insert('withdrawal/effective', 'withdrawnAt,withdrawnById,effectiveAt,effectiveById');
CREATE TRIGGER "DuesActivation_no_delete" BEFORE DELETE ON "DuesActivation" FOR EACH ROW EXECUTE FUNCTION dues_reject_delete();

COMMIT;
