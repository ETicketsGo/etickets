-- The identity that ties one intent's channels together, and the read timestamp.
--
-- `intentKey` is `dedupeKey` without the channel. A fallback has to ask "did ANY of the
-- preferred channels get through", and dedupeKey deliberately differs per channel, so it
-- cannot answer that question. Not unique: several rows share it, which is the point.
ALTER TABLE "Notification" ADD COLUMN "intentKey" TEXT;
CREATE INDEX "Notification_intentKey_idx" ON "Notification"("intentKey");

-- A read is not a delivery. Writing the read time into deliveredAt -- which is what
-- happened before -- overwrote the fact of delivery with a later fact about the same
-- message, so the moment it actually arrived was lost.
ALTER TABLE "NotificationDelivery" ADD COLUMN "readAt" TIMESTAMP(3);
