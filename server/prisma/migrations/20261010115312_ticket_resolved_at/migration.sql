-- AlterTable
ALTER TABLE "Ticket" ADD COLUMN     "resolvedAt" TIMESTAMP(3);

-- Backfill. The auto-resolver's own timestamp is the only resolution time the
-- system ever recorded, so it is the only one that can be recovered: every
-- other resolved ticket predates this column and keeps a null, which the
-- dashboard reports as a sample size rather than hiding in an average.
-- `status <> 'OPEN'` excludes a ticket a student's reply already reopened -
-- `autoResolvedAt` stays set on those, but they are not resolved now.
UPDATE "Ticket"
SET "resolvedAt" = "autoResolvedAt"
WHERE "autoResolvedAt" IS NOT NULL
  AND "status" <> 'OPEN';
