-- Notification cost accounting, and the classification that makes a health report truthful.

-- The show being off is not the same fact as one customer cancelling their own booking.
-- They were briefly the same notification type, which put the emergency SMS fallback on a
-- message that includes somebody cancelling from their own account, deliberately.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'SHOW_CANCELLED';

-- Why the attempt happened. A fallback SMS is the most expensive message this platform
-- sends and an operator resend is support spending money; both are invisible in a total
-- that does not separate them from an ordinary first send.
ALTER TABLE "NotificationDelivery" ADD COLUMN "sendKind" TEXT NOT NULL DEFAULT 'PRIMARY';

-- Whose fault the outcome was. Counting a suppressed address or somebody with no phone
-- number as "Twilio failed" makes Twilio look broken because our customers have
-- preferences, and hides a real outage inside a number that is always high.
ALTER TABLE "NotificationDelivery" ADD COLUMN "outcomeClass" TEXT;

-- Cost in MICROS -- millionths of the currency. Not minor units: SES is $0.10 per THOUSAND
-- emails, a hundredth of a cent each, which in cents rounds to zero or to one and is wrong
-- by orders of magnitude either way. NULL means UNKNOWN, never zero.
ALTER TABLE "NotificationDelivery" ADD COLUMN "costMicro" INTEGER;
ALTER TABLE "NotificationDelivery" ADD COLUMN "costCurrency" TEXT;
ALTER TABLE "NotificationDelivery" ADD COLUMN "costSource" TEXT NOT NULL DEFAULT 'UNKNOWN';
ALTER TABLE "NotificationDelivery" ADD COLUMN "billedUnits" INTEGER;
ALTER TABLE "NotificationDelivery" ADD COLUMN "costCalculatedAt" TIMESTAMP(3);

-- Every existing row keeps `costSource = 'UNKNOWN'`, which is the honest record: nothing
-- was priced before this migration and no rate can be applied retroactively without one
-- being configured. Backfilling zeros would turn "we do not know" into "it was free".
CREATE INDEX "NotificationDelivery_outcomeClass_createdAt_idx"
    ON "NotificationDelivery"("outcomeClass", "createdAt");
CREATE INDEX "NotificationDelivery_sendKind_createdAt_idx"
    ON "NotificationDelivery"("sendKind", "createdAt");

-- The booking a message is about. A relation, not a payload lookup: cost-per-booking has to
-- join, and `payload->>'bookingId'` is a JSON extraction on every row of the largest table
-- on the platform.
ALTER TABLE "Notification" ADD COLUMN "bookingId" TEXT;
CREATE INDEX "Notification_bookingId_idx" ON "Notification"("bookingId");
CREATE INDEX "Notification_type_createdAt_idx" ON "Notification"("type", "createdAt");
-- Deliberately NO foreign key. An accounting column must never be able to stop a message
-- being sent: with a constraint, a payload naming a booking that has since been deleted makes
-- the INSERT fail and the notification is lost. A finance question is not worth a customer'"'"'s
-- ticket. ON DELETE SET NULL would be worse still -- it erases which booking a message
-- belonged to, taking last quarter'"'"'s cost-per-booking with it.

-- What a provider charges, at a point in time.
--
-- A rate compiled into the application is a deploy every time a vendor renegotiates and,
-- worse, silently reprices HISTORY -- last month's report recomputed at today's price.
-- Effective dating is what makes a cost report still true next year. Modelled on TaxRule,
-- which solves the same problem: `*` wildcards, a priority for specificity, and an active
-- flag so a rate is written and reviewed before it applies to money.
--
-- NO PRODUCTION PRICES ARE SEEDED. Real rates depend on a contract, a volume tier and a
-- destination operator; a plausible-looking invented number in an accounting table is worse
-- than none, because it produces a total somebody will believe.
CREATE TABLE "NotificationRate" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "country" TEXT NOT NULL DEFAULT '*',
    "category" TEXT NOT NULL DEFAULT '*',
    "unitPriceMicro" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "billingUnit" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "source" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "NotificationRate_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "NotificationRate_active_provider_channel_country_idx"
    ON "NotificationRate"("active", "provider", "channel", "country");
CREATE INDEX "NotificationRate_effectiveFrom_effectiveTo_idx"
    ON "NotificationRate"("effectiveFrom", "effectiveTo");

-- Why the message exists, on the notification as well as on each attempt: the reason is
-- decided when the message is created -- a fallback SMS is a fallback before anything tries
-- to send it -- and the attempt inherits it rather than guessing from an attempt number.
ALTER TABLE "Notification" ADD COLUMN "sendReason" TEXT NOT NULL DEFAULT 'PRIMARY';
