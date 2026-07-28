-- External booking provider lifecycle fields on BookingWorkflow (ADR-042 §9 P5.2B). All
-- nullable/defaulted so existing LOCAL_AUTHORITATIVE rows and disabled/shadow behaviour are
-- unchanged. No provider secrets or raw payloads are stored. Composite uniques are on
-- nullable columns (Postgres treats NULLs as distinct), so existing rows never conflict.
ALTER TABLE "BookingWorkflow"
  ADD COLUMN "providerRequestIdempotencyKey" TEXT,
  ADD COLUMN "providerReservationExpiresAt" TIMESTAMP(3),
  ADD COLUMN "providerVersion" INTEGER,
  ADD COLUMN "providerLastAttemptAt" TIMESTAMP(3),
  ADD COLUMN "providerAttemptCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "providerLastErrorCode" TEXT,
  ADD COLUMN "providerLastResponseCategory" TEXT,
  ADD COLUMN "providerConfirmedAt" TIMESTAMP(3),
  ADD COLUMN "providerCancelledAt" TIMESTAMP(3),
  ADD COLUMN "providerReconciliationRequired" BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX "BookingWorkflow_selectedProviderCode_providerReservationId_key"
  ON "BookingWorkflow" ("selectedProviderCode", "providerReservationId");
CREATE UNIQUE INDEX "BookingWorkflow_selectedProviderCode_providerBookingId_key"
  ON "BookingWorkflow" ("selectedProviderCode", "providerBookingId");
CREATE INDEX "BookingWorkflow_state_providerStatus_idx"
  ON "BookingWorkflow" ("state", "providerStatus");
CREATE INDEX "BookingWorkflow_providerReservationExpiresAt_idx"
  ON "BookingWorkflow" ("providerReservationExpiresAt");
CREATE INDEX "BookingWorkflow_providerReconciliationRequired_idx"
  ON "BookingWorkflow" ("providerReconciliationRequired");
