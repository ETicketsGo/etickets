-- BookingWorkflow durable ownership (ADR-042 P5.2A). Server-decided owner; the client
-- never selects owner type. ownerId stores the user id (USER), the SHA-256 hash of the
-- anonymous session token (ANONYMOUS_SESSION, never the raw token), or a trusted service
-- identity (INTERNAL). All new columns are nullable so existing rows are unaffected and
-- disabled/shadow behaviour is unchanged.
CREATE TYPE "BookingOwnerType" AS ENUM ('USER', 'ANONYMOUS_SESSION', 'INTERNAL');

ALTER TABLE "BookingWorkflow"
  ADD COLUMN "ownerType" "BookingOwnerType",
  ADD COLUMN "ownerId" TEXT,
  ADD COLUMN "tenantId" TEXT,
  ADD COLUMN "organizerId" TEXT;

CREATE INDEX "BookingWorkflow_ownerType_ownerId_idx" ON "BookingWorkflow" ("ownerType", "ownerId");
CREATE INDEX "BookingWorkflow_tenantId_idx" ON "BookingWorkflow" ("tenantId");
