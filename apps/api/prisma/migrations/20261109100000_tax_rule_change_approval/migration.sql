-- Maker-checker for tax rules (AR-56).
--
-- Additive only: two new enums and one new table. "TaxRule" is not altered, so every rule in
-- the database keeps its current state (active or not, its rate, its dates) and keeps
-- charging exactly what it charges today. Nothing is backfilled.
--
-- Switching a tax rule on, changing who or when a live rule charges, and superseding a live
-- rule's rate are now filed here by one administrator and applied only when a different
-- administrator approves. The CHECK below makes "approved by the person who filed it" a state
-- the database refuses, whatever the application does.
--
-- Rolling back the application code: the previous release never reads this table and writes
-- tax rules directly, as it did before. Rows here are then inert.

-- CreateEnum
CREATE TYPE "TaxRuleChangeAction" AS ENUM ('UPDATE', 'SUPERSEDE');

-- CreateEnum
CREATE TYPE "TaxRuleChangeStatus" AS ENUM ('PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'WITHDRAWN');

-- CreateTable
CREATE TABLE "TaxRuleChange" (
    "id" TEXT NOT NULL,
    "taxRuleId" TEXT NOT NULL,
    "action" "TaxRuleChangeAction" NOT NULL,
    "payload" JSONB NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "baseUpdatedAt" TIMESTAMP(3) NOT NULL,
    "status" "TaxRuleChangeStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
    "submittedByUserId" TEXT NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submissionNote" TEXT,
    "decidedByUserId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "resultTaxRuleId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaxRuleChange_pkey" PRIMARY KEY ("id"),
    -- An approval names a checker who is not the maker.
    CONSTRAINT "TaxRuleChange_approver_is_not_maker" CHECK (
        "status" <> 'APPROVED'
        OR ("decidedByUserId" IS NOT NULL AND "decidedByUserId" <> "submittedByUserId")
    )
);

-- CreateIndex
CREATE INDEX "TaxRuleChange_status_submittedAt_idx" ON "TaxRuleChange"("status", "submittedAt");

-- CreateIndex
CREATE INDEX "TaxRuleChange_taxRuleId_idx" ON "TaxRuleChange"("taxRuleId");
