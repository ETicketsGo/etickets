-- An SNS SubscriptionConfirmation that has been proven to come from Amazon and is waiting for
-- a person to act on it.
--
-- The SES webhook refuses to auto-confirm on purpose, and the handler logs only the
-- SubscribeURL's host, so the token that authorises confirmation had nowhere to live and the
-- required human step could not be taken. This table holds it for one authenticated,
-- audited, one-time reveal.
--
-- Rows are only ever written outside production (see sns-confirmation.guard.ts). The table
-- exists in every environment because a schema that differs per environment is a migration
-- that fails in exactly one of them, at the worst moment.

CREATE TYPE "SnsConfirmationStatus" AS ENUM ('PENDING', 'EXPIRED', 'CONFIRMED');

CREATE TABLE "SnsPendingConfirmation" (
    "id" TEXT NOT NULL,
    "topicArn" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "subscribeUrl" TEXT NOT NULL,
    "status" "SnsConfirmationStatus" NOT NULL DEFAULT 'PENDING',
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revealedAt" TIMESTAMP(3),
    "revealedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SnsPendingConfirmation_pkey" PRIMARY KEY ("id")
);

-- The idempotency guarantee: a redelivered confirmation carries the same SNS MessageId, so a
-- retry is a no-op rather than a second row.
CREATE UNIQUE INDEX "SnsPendingConfirmation_messageId_key" ON "SnsPendingConfirmation"("messageId");

CREATE INDEX "SnsPendingConfirmation_status_receivedAt_idx" ON "SnsPendingConfirmation"("status", "receivedAt");
CREATE INDEX "SnsPendingConfirmation_topicArn_status_idx" ON "SnsPendingConfirmation"("topicArn", "status");
