-- Maker-checker for booking-fee schedules.
--
-- Additive only: new enum values, nullable columns (plus two with defaults), and a new table.
-- Existing drafts keep working: an OPEN draft stays OPEN, and is now submitted for approval
-- instead of published by the person who drafted it. Published rows are untouched.
--
-- New enum values are compared as ::text inside the trigger functions, so nothing here USES a
-- value added in this same migration (PostgreSQL refuses that inside one transaction).

-- CreateEnum
CREATE TYPE "FeeScheduleDecisionAction" AS ENUM ('SUBMITTED', 'WITHDRAWN', 'APPROVED', 'REJECTED', 'EMERGENCY_ROLLBACK');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'FEE_SCHEDULE_AWAITING_APPROVAL';
ALTER TYPE "NotificationType" ADD VALUE 'FEE_SCHEDULE_DECIDED';

-- AlterEnum
ALTER TYPE "FeeScheduleDraftStatus" ADD VALUE 'PENDING_APPROVAL';

-- AlterTable
ALTER TABLE "FeeScheduleDraft" ADD COLUMN     "approvalNote" TEXT,
ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "approvedByUserId" TEXT,
ADD COLUMN     "contributorUserIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "emergency" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "lastRejectionNote" TEXT,
ADD COLUMN     "rollbackOfVersion" INTEGER,
ADD COLUMN     "submissionNote" TEXT,
ADD COLUMN     "submittedAt" TIMESTAMP(3),
ADD COLUMN     "submittedBandsHash" TEXT,
ADD COLUMN     "submittedByUserId" TEXT;

-- CreateTable
CREATE TABLE "FeeScheduleDecision" (
    "id" TEXT NOT NULL,
    "draftId" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "action" "FeeScheduleDecisionAction" NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "note" TEXT,
    "bandsHash" TEXT NOT NULL,
    "version" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FeeScheduleDecision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FeeScheduleDecision_draftId_createdAt_idx" ON "FeeScheduleDecision"("draftId", "createdAt");

-- CreateIndex
CREATE INDEX "FeeScheduleDecision_currency_createdAt_idx" ON "FeeScheduleDecision"("currency", "createdAt");

-- AddForeignKey
ALTER TABLE "FeeScheduleDecision" ADD CONSTRAINT "FeeScheduleDecision_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "FeeScheduleDraft"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- The approval history cannot be rewritten: no UPDATE, no DELETE, by anybody.
CREATE FUNCTION "fee_schedule_decision_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'FeeScheduleDecision is append-only: % refused', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "FeeScheduleDecision_append_only"
  BEFORE UPDATE OR DELETE ON "FeeScheduleDecision"
  FOR EACH ROW EXECUTE FUNCTION "fee_schedule_decision_append_only"();

-- A published schedule version is the history of what buyers were charged: it is never
-- changed or deleted. A draft waiting for approval cannot have its bands changed: the
-- approver approves exactly what was submitted.
CREATE FUNCTION "fee_schedule_draft_guard"() RETURNS trigger AS $$
BEGIN
  IF OLD."status"::text = 'PUBLISHED' THEN
    RAISE EXCEPTION 'FeeScheduleDraft % is a published version and cannot be %', OLD."id", lower(TG_OP)
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'UPDATE'
     AND OLD."status"::text = 'PENDING_APPROVAL'
     AND NEW."bands"::text IS DISTINCT FROM OLD."bands"::text THEN
    RAISE EXCEPTION 'FeeScheduleDraft % is waiting for approval: its bands cannot change', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "FeeScheduleDraft_guard"
  BEFORE UPDATE OR DELETE ON "FeeScheduleDraft"
  FOR EACH ROW EXECUTE FUNCTION "fee_schedule_draft_guard"();
