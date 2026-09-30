-- CreateEnum
CREATE TYPE "ExchangeRateProvider" AS ENUM ('BCR');

-- CreateEnum
CREATE TYPE "ExchangeRateSide" AS ENUM ('SELL');

-- CreateTable
CREATE TABLE "ExchangeRateQuote" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "provider" "ExchangeRateProvider" NOT NULL,
    "pair" TEXT NOT NULL,
    "side" "ExchangeRateSide" NOT NULL,
    "quoteDate" DATE NOT NULL,
    "revision" INTEGER NOT NULL,
    "value" DECIMAL(12,6) NOT NULL,
    "enteredById" TEXT NOT NULL,
    "enteredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceNote" TEXT,
    "supersedesId" TEXT,

    CONSTRAINT "ExchangeRateQuote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ExchangeRateQuote_organizationId_provider_pair_side_quoteDa_idx" ON "ExchangeRateQuote"("organizationId", "provider", "pair", "side", "quoteDate");

-- CreateIndex
CREATE UNIQUE INDEX "ExchangeRateQuote_organizationId_id_key" ON "ExchangeRateQuote"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ExchangeRateQuote_organizationId_provider_pair_side_quoteDa_key" ON "ExchangeRateQuote"("organizationId", "provider", "pair", "side", "quoteDate", "revision");

-- AddForeignKey
ALTER TABLE "ExchangeRateQuote" ADD CONSTRAINT "ExchangeRateQuote_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExchangeRateQuote" ADD CONSTRAINT "ExchangeRateQuote_enteredById_fkey" FOREIGN KEY ("enteredById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExchangeRateQuote" ADD CONSTRAINT "ExchangeRateQuote_organizationId_supersedesId_fkey" FOREIGN KEY ("organizationId", "supersedesId") REFERENCES "ExchangeRateQuote"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Only pair this schema's two currencies can form, and only within the calendar range every other dues table already supports.
-- Both are format/range sanity checks, not business logic (the business rule — organization-wide, SELL rate only — is enforced
-- by application code and by ExchangeRateSide having exactly one value).
ALTER TABLE "ExchangeRateQuote"
  ADD CONSTRAINT "ExchangeRateQuote_pair_valid" CHECK ("pair" = 'USD/CRC'),
  ADD CONSTRAINT "ExchangeRateQuote_revision_positive" CHECK ("revision" >= 1),
  ADD CONSTRAINT "ExchangeRateQuote_value_positive" CHECK ("value" > 0),
  ADD CONSTRAINT "ExchangeRateQuote_quote_date_sane" CHECK (EXTRACT(YEAR FROM "quoteDate") BETWEEN 2000 AND 2100),
  ADD CONSTRAINT "ExchangeRateQuote_source_note_non_blank" CHECK ("sourceNote" IS NULL OR btrim("sourceNote") <> '');

-- Append-only: a correction is a NEW row with a higher revision, never an edit — the identical "history is permanent" guarantee
-- every other dues table already has (DuesObligation, DuesPayment, DuesLateFee, DuesSettlement, DuesCoverage). Reuses the
-- existing generic delete-rejection function; adds one small, table-specific update-rejection function since no existing one
-- fits this table's own message.
CREATE FUNCTION exchange_rate_quote_no_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'dues_ledger: exchange rate quotes are never updated — a correction is a new row with a higher revision' USING ERRCODE = '23514';
END $$;

CREATE TRIGGER "ExchangeRateQuote_no_delete" BEFORE DELETE ON "ExchangeRateQuote" FOR EACH ROW EXECUTE FUNCTION dues_reject_delete();
CREATE TRIGGER "ExchangeRateQuote_no_update" BEFORE UPDATE ON "ExchangeRateQuote" FOR EACH ROW EXECUTE FUNCTION exchange_rate_quote_no_update();
