-- CreateEnum
CREATE TYPE "SettlementReversalStatus" AS ENUM ('REQUESTED', 'PROCESSING', 'COMPLETED', 'FAILED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "ReversalReason" AS ENUM ('REFUND', 'DISPUTE', 'ADJUSTMENT');

-- AlterTable
ALTER TABLE "Settlement" ADD COLUMN     "releasedMinor" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "reversalLedgerFrom" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "SettlementReversalAttempt" (
    "id" TEXT NOT NULL,
    "settlementId" TEXT NOT NULL,
    "reason" "ReversalReason" NOT NULL,
    "refundId" TEXT,
    "disputeId" TEXT,
    "requestedMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "status" "SettlementReversalStatus" NOT NULL DEFAULT 'REQUESTED',
    "confirmedMinor" INTEGER NOT NULL DEFAULT 0,
    "providerReversalId" TEXT,
    "providerStatusRaw" TEXT,
    "syncResponse" JSONB,
    "evidence" JSONB,
    "lastError" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "supersedesId" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedAt" TIMESTAMP(3),
    "settledAt" TIMESTAMP(3),
    "lastReconciledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SettlementReversalAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SettlementReversalAttempt_idempotencyKey_key" ON "SettlementReversalAttempt"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "SettlementReversalAttempt_supersedesId_key" ON "SettlementReversalAttempt"("supersedesId");

-- CreateIndex
CREATE INDEX "SettlementReversalAttempt_settlementId_status_idx" ON "SettlementReversalAttempt"("settlementId", "status");

-- CreateIndex
CREATE INDEX "SettlementReversalAttempt_status_requestedAt_idx" ON "SettlementReversalAttempt"("status", "requestedAt");

-- CreateIndex
CREATE INDEX "SettlementReversalAttempt_providerReversalId_idx" ON "SettlementReversalAttempt"("providerReversalId");

-- CreateIndex
CREATE INDEX "SettlementReversalAttempt_refundId_idx" ON "SettlementReversalAttempt"("refundId");

-- CreateIndex
CREATE INDEX "SettlementReversalAttempt_disputeId_idx" ON "SettlementReversalAttempt"("disputeId");

-- CreateIndex
CREATE UNIQUE INDEX "SettlementReversalAttempt_provider_providerReversalId_key" ON "SettlementReversalAttempt"("provider", "providerReversalId");

-- AddForeignKey
ALTER TABLE "SettlementReversalAttempt" ADD CONSTRAINT "SettlementReversalAttempt_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "Settlement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SettlementReversalAttempt" ADD CONSTRAINT "SettlementReversalAttempt_supersedesId_fkey" FOREIGN KEY ("supersedesId") REFERENCES "SettlementReversalAttempt"("id") ON DELETE SET NULL ON UPDATE CASCADE;
