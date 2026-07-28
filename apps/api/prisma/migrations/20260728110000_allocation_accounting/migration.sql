-- Transactional allocation accounting (ADR-042 P5.3A.1). Authoritative held/confirmed
-- consumption counters on ProviderInventoryState, plus a per-booking exactly-once marker on
-- BookingWorkflow. All additive/defaulted; existing rows and disabled/local behaviour unchanged.
ALTER TABLE "ProviderInventoryState"
  ADD COLUMN "heldLocal" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "confirmedLocal" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "BookingWorkflow"
  ADD COLUMN "allocationProviderCode" TEXT,
  ADD COLUMN "allocationExternalRef" TEXT,
  ADD COLUMN "allocationHeldQty" INTEGER,
  ADD COLUMN "allocationAccountingState" TEXT NOT NULL DEFAULT 'NONE';
