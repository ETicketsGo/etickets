-- CreateEnum
CREATE TYPE "ConnectOnboardingStatus" AS ENUM ('NOT_STARTED', 'ONBOARDING', 'PENDING_VERIFICATION', 'ENABLED', 'RESTRICTED', 'DISABLED', 'REJECTED');

-- CreateEnum
CREATE TYPE "SettlementStatus" AS ENUM ('PENDING', 'HELD', 'ELIGIBLE', 'APPROVED', 'TRANSFER_PROCESSING', 'TRANSFERRED', 'PARTIALLY_REFUNDED', 'BLOCKED', 'FAILED', 'REVERSED');

-- CreateEnum
CREATE TYPE "WebhookProcessingStatus" AS ENUM ('RECEIVED', 'PROCESSING', 'PROCESSED', 'FAILED', 'DEAD_LETTER', 'IGNORED');

-- CreateEnum
CREATE TYPE "DisputeStatus" AS ENUM ('NEEDS_RESPONSE', 'UNDER_REVIEW', 'WON', 'LOST', 'WARNING_CLOSED', 'CLOSED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'PAYOUT_ACCOUNT_UPDATED';
ALTER TYPE "NotificationType" ADD VALUE 'SETTLEMENT_RELEASED';
ALTER TYPE "NotificationType" ADD VALUE 'PAYMENT_DISPUTE_OPENED';
ALTER TYPE "NotificationType" ADD VALUE 'PAYMENT_DISPUTE_CLOSED';
ALTER TYPE "NotificationType" ADD VALUE 'TRANSFER_FAILED';

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "connectedAccountId" TEXT,
ADD COLUMN     "failureCode" TEXT,
ADD COLUMN     "failureMessage" TEXT,
ADD COLUMN     "idempotencyKey" TEXT,
ADD COLUMN     "metadata" JSONB,
ADD COLUMN     "organizerNetMinor" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "paidAt" TIMESTAMP(3),
ADD COLUMN     "platformFeeMinor" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "processingFeeMinor" INTEGER,
ADD COLUMN     "providerCheckoutSessionId" TEXT,
ADD COLUMN     "providerPaymentIntentId" TEXT,
ADD COLUMN     "refundedMinor" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "settlementId" TEXT,
ADD COLUMN     "subtotalMinor" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "taxMinor" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "OrganizerPaymentAccount" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'stripe',
    "providerAccountId" TEXT,
    "accountType" TEXT NOT NULL DEFAULT 'express',
    "onboardingStatus" "ConnectOnboardingStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "detailsSubmitted" BOOLEAN NOT NULL DEFAULT false,
    "chargesEnabled" BOOLEAN NOT NULL DEFAULT false,
    "payoutsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "requirementsDue" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "disabledReason" TEXT,
    "country" TEXT NOT NULL DEFAULT 'US',
    "defaultCurrency" TEXT NOT NULL DEFAULT 'usd',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizerPaymentAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Settlement" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "accountId" TEXT,
    "provider" TEXT NOT NULL DEFAULT 'stripe',
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "grossSalesMinor" INTEGER NOT NULL DEFAULT 0,
    "refundsMinor" INTEGER NOT NULL DEFAULT 0,
    "disputesMinor" INTEGER NOT NULL DEFAULT 0,
    "platformFeesMinor" INTEGER NOT NULL DEFAULT 0,
    "reserveMinor" INTEGER NOT NULL DEFAULT 0,
    "payableMinor" INTEGER NOT NULL DEFAULT 0,
    "transferredMinor" INTEGER NOT NULL DEFAULT 0,
    "providerTransferId" TEXT,
    "connectedAccountId" TEXT,
    "status" "SettlementStatus" NOT NULL DEFAULT 'PENDING',
    "approvedByUserId" TEXT,
    "blockedReason" TEXT,
    "failureMessage" TEXT,
    "releasedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Settlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'stripe',
    "providerEventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payloadHash" TEXT,
    "payload" JSONB,
    "processingStatus" "WebhookProcessingStatus" NOT NULL DEFAULT 'RECEIVED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "processedAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Dispute" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'stripe',
    "providerDisputeId" TEXT NOT NULL,
    "paymentId" TEXT,
    "bookingId" TEXT,
    "organizationId" TEXT,
    "eventId" TEXT,
    "amountMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "reason" TEXT,
    "status" "DisputeStatus" NOT NULL DEFAULT 'NEEDS_RESPONSE',
    "stripeStatus" TEXT,
    "evidenceDueBy" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Dispute_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrganizerPaymentAccount_providerAccountId_idx" ON "OrganizerPaymentAccount"("providerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizerPaymentAccount_organizationId_provider_key" ON "OrganizerPaymentAccount"("organizationId", "provider");

-- CreateIndex
CREATE INDEX "Settlement_organizationId_status_idx" ON "Settlement"("organizationId", "status");

-- CreateIndex
CREATE INDEX "Settlement_status_idx" ON "Settlement"("status");

-- CreateIndex
CREATE INDEX "Settlement_providerTransferId_idx" ON "Settlement"("providerTransferId");

-- CreateIndex
CREATE UNIQUE INDEX "Settlement_eventId_currency_key" ON "Settlement"("eventId", "currency");

-- CreateIndex
CREATE INDEX "WebhookEvent_processingStatus_idx" ON "WebhookEvent"("processingStatus");

-- CreateIndex
CREATE INDEX "WebhookEvent_provider_eventType_idx" ON "WebhookEvent"("provider", "eventType");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_provider_providerEventId_key" ON "WebhookEvent"("provider", "providerEventId");

-- CreateIndex
CREATE INDEX "Dispute_organizationId_idx" ON "Dispute"("organizationId");

-- CreateIndex
CREATE INDEX "Dispute_status_idx" ON "Dispute"("status");

-- CreateIndex
CREATE INDEX "Dispute_paymentId_idx" ON "Dispute"("paymentId");

-- CreateIndex
CREATE UNIQUE INDEX "Dispute_provider_providerDisputeId_key" ON "Dispute"("provider", "providerDisputeId");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_idempotencyKey_key" ON "Payment"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Payment_providerPaymentIntentId_idx" ON "Payment"("providerPaymentIntentId");

-- CreateIndex
CREATE INDEX "Payment_connectedAccountId_idx" ON "Payment"("connectedAccountId");

-- CreateIndex
CREATE INDEX "Payment_settlementId_idx" ON "Payment"("settlementId");

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "Settlement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizerPaymentAccount" ADD CONSTRAINT "OrganizerPaymentAccount_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Settlement" ADD CONSTRAINT "Settlement_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Settlement" ADD CONSTRAINT "Settlement_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Settlement" ADD CONSTRAINT "Settlement_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "OrganizerPaymentAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Dispute" ADD CONSTRAINT "Dispute_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Dispute" ADD CONSTRAINT "Dispute_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

