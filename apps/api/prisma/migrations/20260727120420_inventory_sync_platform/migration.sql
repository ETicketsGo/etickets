-- CreateEnum
CREATE TYPE "SyncEventStatus" AS ENUM ('RECEIVED', 'VERIFIED', 'REJECTED', 'QUEUED', 'PROCESSING', 'PROCESSED', 'RETRYABLE_FAILURE', 'PERMANENT_FAILURE', 'DEAD_LETTERED', 'MANUAL_REVIEW', 'DUPLICATE');

-- CreateEnum
CREATE TYPE "ProviderMappingStatus" AS ENUM ('ACTIVE', 'UNMAPPED', 'AMBIGUOUS', 'DISABLED', 'DELETED', 'MANUAL_REVIEW');

-- CreateEnum
CREATE TYPE "InventoryOwnershipMode" AS ENUM ('LOCAL_AUTHORITATIVE', 'PROVIDER_AUTHORITATIVE', 'ALLOCATED');

-- CreateTable
CREATE TABLE "RawProviderEvent" (
    "id" TEXT NOT NULL,
    "providerCode" TEXT NOT NULL,
    "providerTenantId" TEXT NOT NULL DEFAULT '',
    "externalEventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "eventVersion" INTEGER,
    "externalEntityId" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "providerOccurredAt" TIMESTAMP(3),
    "signatureStatus" TEXT NOT NULL DEFAULT 'UNVERIFIED',
    "processingStatus" "SyncEventStatus" NOT NULL DEFAULT 'RECEIVED',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "payloadHash" TEXT NOT NULL,
    "payloadJson" JSONB,
    "headersMetadata" JSONB,
    "correlationId" TEXT,
    "lastErrorCode" TEXT,
    "lastErrorMessage" TEXT,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RawProviderEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderMapping" (
    "id" TEXT NOT NULL,
    "providerCode" TEXT NOT NULL,
    "providerTenantId" TEXT NOT NULL DEFAULT '',
    "externalEntityType" TEXT NOT NULL,
    "externalEntityId" TEXT NOT NULL,
    "internalEntityType" TEXT,
    "internalEntityId" TEXT,
    "externalVersion" INTEGER,
    "ownershipMode" "InventoryOwnershipMode" NOT NULL DEFAULT 'PROVIDER_AUTHORITATIVE',
    "lastProviderUpdatedAt" TIMESTAMP(3),
    "lastSyncedAt" TIMESTAMP(3),
    "status" "ProviderMappingStatus" NOT NULL DEFAULT 'UNMAPPED',
    "mappingMetadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderSyncCheckpoint" (
    "id" TEXT NOT NULL,
    "providerCode" TEXT NOT NULL,
    "providerTenantId" TEXT NOT NULL DEFAULT '',
    "resource" TEXT NOT NULL,
    "cursor" TEXT,
    "watermark" TIMESTAMP(3),
    "lastSuccessfulPollAt" TIMESTAMP(3),
    "nextPollAt" TIMESTAMP(3),
    "leaseOwner" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderSyncCheckpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderInventoryState" (
    "id" TEXT NOT NULL,
    "providerCode" TEXT NOT NULL,
    "providerTenantId" TEXT NOT NULL DEFAULT '',
    "externalSessionId" TEXT NOT NULL,
    "ownershipMode" "InventoryOwnershipMode" NOT NULL DEFAULT 'PROVIDER_AUTHORITATIVE',
    "seatStates" JSONB,
    "layoutVersion" TEXT,
    "providerRemaining" INTEGER,
    "providerCapacity" INTEGER,
    "pendingLocal" INTEGER NOT NULL DEFAULT 0,
    "safetyBuffer" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "providerUpdatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderInventoryState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RawProviderEvent_processingStatus_idx" ON "RawProviderEvent"("processingStatus");

-- CreateIndex
CREATE INDEX "RawProviderEvent_providerCode_eventType_idx" ON "RawProviderEvent"("providerCode", "eventType");

-- CreateIndex
CREATE INDEX "RawProviderEvent_receivedAt_idx" ON "RawProviderEvent"("receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "RawProviderEvent_providerCode_providerTenantId_externalEven_key" ON "RawProviderEvent"("providerCode", "providerTenantId", "externalEventId");

-- CreateIndex
CREATE INDEX "ProviderMapping_status_idx" ON "ProviderMapping"("status");

-- CreateIndex
CREATE INDEX "ProviderMapping_internalEntityType_internalEntityId_idx" ON "ProviderMapping"("internalEntityType", "internalEntityId");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderMapping_providerCode_providerTenantId_externalEntit_key" ON "ProviderMapping"("providerCode", "providerTenantId", "externalEntityType", "externalEntityId");

-- CreateIndex
CREATE INDEX "ProviderSyncCheckpoint_nextPollAt_idx" ON "ProviderSyncCheckpoint"("nextPollAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderSyncCheckpoint_providerCode_providerTenantId_resour_key" ON "ProviderSyncCheckpoint"("providerCode", "providerTenantId", "resource");

-- CreateIndex
CREATE INDEX "ProviderInventoryState_externalSessionId_idx" ON "ProviderInventoryState"("externalSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderInventoryState_providerCode_providerTenantId_extern_key" ON "ProviderInventoryState"("providerCode", "providerTenantId", "externalSessionId");
