-- CreateEnum
CREATE TYPE "BookingWorkflowState" AS ENUM ('DRAFT', 'INVENTORY_RESOLVED', 'LOCK_PENDING', 'LOCKED', 'PAYMENT_PENDING', 'PAYMENT_AUTHORIZED', 'PROVIDER_CONFIRM_PENDING', 'PROVIDER_CONFIRMED', 'CONFIRMING', 'CONFIRMED', 'TICKET_PENDING', 'TICKET_ISSUED', 'CANCELLATION_PENDING', 'CANCELLED', 'REFUND_PENDING', 'REFUNDED', 'EXPIRING', 'EXPIRED', 'COMPENSATION_PENDING', 'COMPENSATED', 'MANUAL_REVIEW', 'FAILED');

-- CreateTable
CREATE TABLE "BookingWorkflow" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "workflowType" TEXT NOT NULL DEFAULT 'BOOKING',
    "state" "BookingWorkflowState" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 0,
    "selectedProviderCode" TEXT,
    "inventoryOwnershipMode" "InventoryOwnershipMode" NOT NULL DEFAULT 'LOCAL_AUTHORITATIVE',
    "lockId" TEXT,
    "fencingToken" INTEGER,
    "paymentProvider" TEXT,
    "providerReservationId" TEXT,
    "providerBookingId" TEXT,
    "providerStatus" TEXT,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "nextActionAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "manualReviewReason" TEXT,
    "correlationId" TEXT,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookingWorkflow_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BookingWorkflow_bookingId_key" ON "BookingWorkflow"("bookingId");

-- CreateIndex
CREATE INDEX "BookingWorkflow_state_nextActionAt_idx" ON "BookingWorkflow"("state", "nextActionAt");

-- CreateIndex
CREATE INDEX "BookingWorkflow_selectedProviderCode_idx" ON "BookingWorkflow"("selectedProviderCode");

-- CreateIndex
CREATE INDEX "BookingWorkflow_correlationId_idx" ON "BookingWorkflow"("correlationId");

-- CreateIndex
CREATE UNIQUE INDEX "BookingWorkflow_workflowType_idempotencyKey_key" ON "BookingWorkflow"("workflowType", "idempotencyKey");
