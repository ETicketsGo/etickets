-- Delivery receipts: what actually happened after a message left the platform.
--
-- Phase 1 recorded the provider and its message id on the Notification itself, which is
-- correct for one attempt and wrong for two: each retry gets its own provider reference,
-- and a callback arriving later correlates on that reference. A single column loses the
-- first attempt's identity the moment a second is made.

CREATE TABLE "NotificationDelivery" (
    "id" TEXT NOT NULL,
    "notificationId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "providerMessageId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "providerStatus" TEXT,
    "failureCode" TEXT,
    "failureReason" TEXT,
    "attemptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "NotificationDelivery_pkey" PRIMARY KEY ("id")
);

-- One row per attempt. A concurrent retry cannot create a second attempt 1.
CREATE UNIQUE INDEX "NotificationDelivery_notificationId_attemptNumber_key"
    ON "NotificationDelivery"("notificationId", "attemptNumber");
-- How a webhook finds the attempt it is about. Deliberately NOT unique: a provider that
-- reuses a reference must not be able to break ingestion.
CREATE INDEX "NotificationDelivery_provider_providerMessageId_idx"
    ON "NotificationDelivery"("provider", "providerMessageId");
CREATE INDEX "NotificationDelivery_status_createdAt_idx"
    ON "NotificationDelivery"("status", "createdAt");
CREATE INDEX "NotificationDelivery_provider_channel_createdAt_idx"
    ON "NotificationDelivery"("provider", "channel", "createdAt");

ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_notificationId_fkey"
    FOREIGN KEY ("notificationId") REFERENCES "Notification"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Destinations that must not be sent to again.
--
-- Separate from MarketingConsent on purpose: consent governs promotional mail and its
-- absence must never withhold a ticket, while suppression governs whether a destination
-- works at all and MUST stop transactional mail too -- continuing to email an address that
-- hard-bounces is what gets a sending domain throttled.
--
-- The destination is stored as a hash. The only operation is "is this suppressed", which a
-- hash answers exactly as well, and the alternative is a table of real verified contact
-- details whose whole purpose is to be read on every send.
CREATE TABLE "SuppressedDestination" (
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "destinationHash" TEXT NOT NULL,
    "destinationMask" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "provider" TEXT,
    "sourceDeliveryId" TEXT,
    "suppressedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "liftedAt" TIMESTAMP(3),
    "liftedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SuppressedDestination_pkey" PRIMARY KEY ("id")
);

-- Per channel: a dead mailbox says nothing about a phone.
CREATE UNIQUE INDEX "SuppressedDestination_channel_destinationHash_key"
    ON "SuppressedDestination"("channel", "destinationHash");
CREATE INDEX "SuppressedDestination_reason_suppressedAt_idx"
    ON "SuppressedDestination"("reason", "suppressedAt");
