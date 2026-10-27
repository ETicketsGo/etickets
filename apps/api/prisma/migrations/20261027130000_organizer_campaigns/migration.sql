-- Organizer email campaigns: campaigns, their recipients, an append-only event history,
-- tracked links and clicks, and saved audience segments. Additive only: six new tables and two
-- enums. Nothing that exists is altered, so it is safe to apply before the code that reads it.

-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'PENDING_APPROVAL', 'QUEUED', 'SENDING', 'PAUSED', 'COMPLETED', 'PARTIALLY_FAILED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CampaignRecipientStatus" AS ENUM ('PENDING', 'SKIPPED_CONSENT', 'SKIPPED_SUPPRESSED', 'QUEUED', 'ACCEPTED', 'DELIVERED', 'DEFERRED', 'BOUNCED', 'COMPLAINED', 'FAILED', 'UNSUBSCRIBED');

-- CreateTable
CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "previewText" TEXT,
    "senderName" TEXT NOT NULL,
    "replyTo" TEXT,
    "purpose" TEXT NOT NULL,
    "templateKey" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "eventId" TEXT,
    "audience" JSONB NOT NULL,
    "status" "CampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "scheduledAt" TIMESTAMP(3),
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "quietHours" JSONB,
    "locale" TEXT NOT NULL DEFAULT 'en',
    "createdByUserId" TEXT NOT NULL,
    "updatedByUserId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "counters" JSONB,
    "pausedReason" TEXT,
    "failureReason" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "confirmedByUserId" TEXT,
    "queuedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignRecipient" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT,
    "emailHash" TEXT NOT NULL,
    "destination" TEXT,
    "destinationMask" TEXT NOT NULL,
    "status" "CampaignRecipientStatus" NOT NULL DEFAULT 'PENDING',
    "provider" TEXT,
    "providerMessageId" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "queuedAt" TIMESTAMP(3),
    "acceptedAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "finalAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignRecipient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignEvent" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "recipientId" TEXT,
    "type" TEXT NOT NULL,
    "providerEventId" TEXT,
    "actorUserId" TEXT,
    "detail" JSONB,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignLink" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "targetUrl" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignClick" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,
    "clicks" INTEGER NOT NULL DEFAULT 1,
    "firstClickedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastClickedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignClick_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SavedSegment" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "definition" JSONB NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SavedSegment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Campaign_organizationId_status_createdAt_idx" ON "Campaign"("organizationId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "Campaign_status_scheduledAt_idx" ON "Campaign"("status", "scheduledAt");

-- CreateIndex
CREATE INDEX "CampaignRecipient_campaignId_status_idx" ON "CampaignRecipient"("campaignId", "status");

-- CreateIndex
CREATE INDEX "CampaignRecipient_providerMessageId_idx" ON "CampaignRecipient"("providerMessageId");

-- CreateIndex
CREATE INDEX "CampaignRecipient_organizationId_emailHash_idx" ON "CampaignRecipient"("organizationId", "emailHash");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignRecipient_campaignId_emailHash_key" ON "CampaignRecipient"("campaignId", "emailHash");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignEvent_providerEventId_key" ON "CampaignEvent"("providerEventId");

-- CreateIndex
CREATE INDEX "CampaignEvent_campaignId_type_occurredAt_idx" ON "CampaignEvent"("campaignId", "type", "occurredAt");

-- CreateIndex
CREATE INDEX "CampaignEvent_recipientId_idx" ON "CampaignEvent"("recipientId");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignLink_campaignId_targetUrl_key" ON "CampaignLink"("campaignId", "targetUrl");

-- CreateIndex
CREATE INDEX "CampaignClick_campaignId_recipientId_firstClickedAt_idx" ON "CampaignClick"("campaignId", "recipientId", "firstClickedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignClick_linkId_recipientId_key" ON "CampaignClick"("linkId", "recipientId");

-- CreateIndex
CREATE UNIQUE INDEX "SavedSegment_organizationId_name_key" ON "SavedSegment"("organizationId", "name");

