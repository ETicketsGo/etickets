-- CreateEnum
CREATE TYPE "SettlementFindingKind" AS ENUM ('AMOUNT_DISAGREES', 'CURRENCY_DISAGREES', 'PROVIDER_CONTRADICTS_LOCAL', 'PROVIDER_HAS_NO_RECORD', 'STILL_UNRESOLVED', 'CANNOT_BE_ASKED');

-- CreateEnum
CREATE TYPE "SettlementFindingStatus" AS ENUM ('OPEN', 'RESOLVED');

-- CreateTable
CREATE TABLE "SettlementReconciliationFinding" (
    "id" TEXT NOT NULL,
    "settlementId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "transferAttemptId" TEXT NOT NULL,
    "kind" "SettlementFindingKind" NOT NULL,
    "status" "SettlementFindingStatus" NOT NULL DEFAULT 'OPEN',
    "localStatus" TEXT NOT NULL,
    "localAmountMinor" INTEGER NOT NULL,
    "localCurrency" TEXT NOT NULL,
    "providerDisposition" TEXT,
    "providerAmountMinor" INTEGER,
    "providerCurrency" TEXT,
    "providerStatusRaw" TEXT,
    "detail" TEXT NOT NULL,
    "discoveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "observationCount" INTEGER NOT NULL DEFAULT 1,
    "resolvedAt" TIMESTAMP(3),
    "resolvedByUserId" TEXT,
    "resolutionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SettlementReconciliationFinding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SettlementReconciliationFinding_status_discoveredAt_idx" ON "SettlementReconciliationFinding"("status", "discoveredAt");

-- CreateIndex
CREATE INDEX "SettlementReconciliationFinding_organizationId_status_idx" ON "SettlementReconciliationFinding"("organizationId", "status");

-- CreateIndex
CREATE INDEX "SettlementReconciliationFinding_settlementId_idx" ON "SettlementReconciliationFinding"("settlementId");

-- CreateIndex
CREATE UNIQUE INDEX "SettlementReconciliationFinding_transferAttemptId_kind_key" ON "SettlementReconciliationFinding"("transferAttemptId", "kind");

-- AddForeignKey
ALTER TABLE "SettlementReconciliationFinding" ADD CONSTRAINT "SettlementReconciliationFinding_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "Settlement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SettlementReconciliationFinding" ADD CONSTRAINT "SettlementReconciliationFinding_transferAttemptId_fkey" FOREIGN KEY ("transferAttemptId") REFERENCES "SettlementTransferAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;
