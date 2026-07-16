-- CreateEnum
CREATE TYPE "ReconcileReviewState" AS ENUM ('NOT_REQUIRED', 'PENDING', 'RESOLVED');

-- CreateEnum
CREATE TYPE "ReconcileResolutionAction" AS ENUM ('ACKNOWLEDGED', 'DISMISSED');

-- CreateTable
CREATE TABLE "OfflineReconciliationRecord" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "eventId" TEXT,
    "eventSessionId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "operatorUserId" TEXT,
    "localScannedAt" TIMESTAMP(3) NOT NULL,
    "reconciledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "outcome" TEXT NOT NULL,
    "wasOverride" BOOLEAN NOT NULL DEFAULT false,
    "reviewState" "ReconcileReviewState" NOT NULL DEFAULT 'NOT_REQUIRED',
    "resolutionAction" "ReconcileResolutionAction",
    "resolutionReason" TEXT,
    "resolvedByUserId" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OfflineReconciliationRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OfflineReconciliationRecord_organizationId_eventSessionId_idx" ON "OfflineReconciliationRecord"("organizationId", "eventSessionId");

-- CreateIndex
CREATE INDEX "OfflineReconciliationRecord_organizationId_reviewState_idx" ON "OfflineReconciliationRecord"("organizationId", "reviewState");

-- CreateIndex
CREATE INDEX "OfflineReconciliationRecord_organizationId_outcome_idx" ON "OfflineReconciliationRecord"("organizationId", "outcome");

-- CreateIndex
CREATE INDEX "OfflineReconciliationRecord_deviceId_idx" ON "OfflineReconciliationRecord"("deviceId");

-- CreateIndex
CREATE INDEX "OfflineReconciliationRecord_ticketId_idx" ON "OfflineReconciliationRecord"("ticketId");
