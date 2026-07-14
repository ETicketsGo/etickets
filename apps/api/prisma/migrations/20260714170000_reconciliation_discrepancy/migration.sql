-- CreateEnum
CREATE TYPE "DiscrepancyType" AS ENUM ('PAYMENT_MISSING_INTERNALLY', 'PAYMENT_MISSING_AT_PROVIDER', 'AMOUNT_MISMATCH', 'CURRENCY_MISMATCH', 'DUPLICATE_CAPTURE', 'REFUND_MISMATCH', 'CHARGEBACK', 'SETTLEMENT_MISMATCH', 'GATEWAY_FEE_MISMATCH', 'ORGANIZER_PAYABLE_MISMATCH');

-- CreateEnum
CREATE TYPE "DiscrepancyStatus" AS ENUM ('OPEN', 'ASSIGNED', 'RESOLVED', 'IGNORED');

-- CreateTable
CREATE TABLE "ReconciliationDiscrepancy" (
    "id" TEXT NOT NULL,
    "env" "PaymentEnv" NOT NULL,
    "type" "DiscrepancyType" NOT NULL,
    "provider" TEXT NOT NULL,
    "entityRef" TEXT NOT NULL,
    "amountMinor" INTEGER,
    "currency" TEXT,
    "detail" TEXT,
    "status" "DiscrepancyStatus" NOT NULL DEFAULT 'OPEN',
    "assignedToUserId" TEXT,
    "resolutionNotes" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReconciliationDiscrepancy_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReconciliationDiscrepancy_status_idx" ON "ReconciliationDiscrepancy"("status");

-- CreateIndex
CREATE INDEX "ReconciliationDiscrepancy_env_type_idx" ON "ReconciliationDiscrepancy"("env", "type");

-- CreateIndex
CREATE INDEX "ReconciliationDiscrepancy_entityRef_idx" ON "ReconciliationDiscrepancy"("entityRef");
