-- CreateEnum
CREATE TYPE "SettlementTransferStatus" AS ENUM ('REQUESTED', 'SUCCEEDED', 'FAILED', 'UNKNOWN');

-- CreateTable
CREATE TABLE "SettlementTransferAttempt" (
    "id" TEXT NOT NULL,
    "settlementId" TEXT NOT NULL,
    "requestedMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "destinationAccountId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "status" "SettlementTransferStatus" NOT NULL DEFAULT 'REQUESTED',
    "providerTransferId" TEXT,
    "providerStatusRaw" TEXT,
    "syncResponse" JSONB,
    "lastError" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedAt" TIMESTAMP(3),
    "lastReconciledAt" TIMESTAMP(3),
    "reconcileCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SettlementTransferAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SettlementTransferAttempt_settlementId_status_idx" ON "SettlementTransferAttempt"("settlementId", "status");

-- CreateIndex
CREATE INDEX "SettlementTransferAttempt_status_requestedAt_idx" ON "SettlementTransferAttempt"("status", "requestedAt");

-- CreateIndex
CREATE INDEX "SettlementTransferAttempt_providerTransferId_idx" ON "SettlementTransferAttempt"("providerTransferId");

-- CreateIndex
CREATE INDEX "SettlementTransferAttempt_settlementId_idempotencyKey_idx" ON "SettlementTransferAttempt"("settlementId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "SettlementTransferAttempt" ADD CONSTRAINT "SettlementTransferAttempt_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "Settlement"("id") ON DELETE CASCADE ON UPDATE CASCADE;
