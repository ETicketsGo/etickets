-- When and why a check-in device was revoked (owner decision, 2026-10-26: a suspended
-- organization loses check-in authorization, and its devices are revoked at once).
--
-- Additive and backward compatible:
--   * two NULLABLE columns on "CheckInDevice", no default and no backfill. Existing rows keep
--     NULL, which means "not recorded" - the status column still says whether a device is
--     revoked, exactly as before. Existing inserts and updates that do not name them keep working.
-- Rollback: the previous API ignores both; dropping is never required to roll back.

ALTER TABLE "CheckInDevice" ADD COLUMN "revokedAt" TIMESTAMP(3);
ALTER TABLE "CheckInDevice" ADD COLUMN "revokeReason" TEXT;
