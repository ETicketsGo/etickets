-- CreateEnum
CREATE TYPE "OfflineDrillKey" AS ENUM ('TWO_DEVICE_CONFLICT', 'DEVICE_LOSS', 'RECONCILIATION', 'NETWORK_LOSS');

-- CreateEnum
CREATE TYPE "OfflineDrillOutcome" AS ENUM ('PASS', 'FAIL');

-- CreateTable
CREATE TABLE "OfflineDrillRun" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "eventId" TEXT,
    "eventSessionId" TEXT,
    "drillKey" "OfflineDrillKey" NOT NULL,
    "outcome" "OfflineDrillOutcome" NOT NULL,
    "summary" TEXT NOT NULL,
    "evidence" JSONB,
    "ranByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OfflineDrillRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OfflineDrillRun_organizationId_drillKey_createdAt_idx" ON "OfflineDrillRun"("organizationId", "drillKey", "createdAt");
