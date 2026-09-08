-- Notification: which provider carried the message, its reference, and a durable
-- identity for the intent so a redelivered event cannot send twice.
--
-- All three are nullable and additive. Every existing row keeps its meaning: a NULL
-- dedupeKey is "not subject to suppression", and Postgres allows any number of NULLs
-- in a unique index, so back-filling nothing is the correct migration.
ALTER TABLE "Notification" ADD COLUMN "provider" TEXT;
ALTER TABLE "Notification" ADD COLUMN "providerMessageId" TEXT;
ALTER TABLE "Notification" ADD COLUMN "dedupeKey" TEXT;

-- The guarantee itself. Two concurrent workers inserting the same intent: one commits,
-- the other gets a unique violation and stands down. This index is the whole mechanism —
-- nothing in application memory is relied on.
CREATE UNIQUE INDEX "Notification_dedupeKey_key" ON "Notification"("dedupeKey");
