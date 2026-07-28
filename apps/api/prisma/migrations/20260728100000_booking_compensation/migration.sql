-- Booking compensation foundation (ADR-043, P5.3A). One durable, idempotent recovery action
-- per booking target. Additive; no existing table changes. Execution is flag-gated (all off
-- by default); money-moving actions stay disabled in P5.3A.
CREATE TYPE "CompensationType" AS ENUM (
  'PAYMENT_VOID','PAYMENT_REFUND','PROVIDER_RESERVATION_CANCEL','PROVIDER_BOOKING_CANCEL',
  'LOCAL_HOLD_RELEASE','REDIS_LOCK_RELEASE','LOCAL_CONFIRMATION_RETRY','PROVIDER_STATUS_RECOVERY',
  'MANUAL_REVIEW'
);
CREATE TYPE "CompensationState" AS ENUM (
  'PLANNED','READY','PROCESSING','RETRYABLE_FAILURE','COMPLETED','DEAD_LETTERED','MANUAL_REVIEW','CANCELLED'
);

CREATE TABLE "BookingCompensation" (
  "id" TEXT NOT NULL,
  "bookingId" TEXT NOT NULL,
  "workflowId" TEXT,
  "tenantId" TEXT,
  "compensationType" "CompensationType" NOT NULL,
  "state" "CompensationState" NOT NULL DEFAULT 'PLANNED',
  "version" INTEGER NOT NULL DEFAULT 0,
  "reasonCode" TEXT NOT NULL,
  "targetReference" TEXT NOT NULL DEFAULT '',
  "generation" INTEGER NOT NULL DEFAULT 1,
  "paymentProvider" TEXT,
  "paymentReference" TEXT,
  "externalProviderCode" TEXT,
  "providerReservationId" TEXT,
  "providerBookingId" TEXT,
  "amountMinor" INTEGER,
  "currency" TEXT,
  "idempotencyKey" TEXT NOT NULL,
  "autoExecutable" BOOLEAN NOT NULL DEFAULT false,
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL DEFAULT 5,
  "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lockedBy" TEXT,
  "lockedAt" TIMESTAMP(3),
  "lockExpiresAt" TIMESTAMP(3),
  "lastAttemptAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "failedAt" TIMESTAMP(3),
  "lastErrorCode" TEXT,
  "lastErrorMessage" TEXT,
  "manualReviewReason" TEXT,
  "correlationId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BookingCompensation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "BookingCompensation_bookingId_compensationType_targetReference_generation_key"
  ON "BookingCompensation" ("bookingId","compensationType","targetReference","generation");
CREATE UNIQUE INDEX "BookingCompensation_idempotencyKey_key" ON "BookingCompensation" ("idempotencyKey");
CREATE INDEX "BookingCompensation_state_availableAt_idx" ON "BookingCompensation" ("state","availableAt");
CREATE INDEX "BookingCompensation_bookingId_idx" ON "BookingCompensation" ("bookingId");
CREATE INDEX "BookingCompensation_tenantId_idx" ON "BookingCompensation" ("tenantId");
CREATE INDEX "BookingCompensation_lockExpiresAt_idx" ON "BookingCompensation" ("lockExpiresAt");
