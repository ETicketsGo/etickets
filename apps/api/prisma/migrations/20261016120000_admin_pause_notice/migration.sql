-- When the platform team pauses an event, the organizer is told, and told why.
--
-- A pause by an admin set `pausedByAdminAt` and wrote the reason to the audit log, which the
-- organizer cannot read. Nothing was sent, so sales stopped silently and the event page said
-- only "paused by the platform team".
--
-- Purely additive: one nullable column and two notification types. An older API ignores the
-- column and never sends the new types, so it keeps working against a migrated database.

ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'EVENT_PAUSED_BY_ADMIN';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'EVENT_RESUMED_BY_ADMIN';

-- AlterTable
ALTER TABLE "Event" ADD COLUMN "pausedByAdminReason" TEXT;
