-- Offline gate check-in (ADR-035). Additive; feature-flagged OFF by default.

CREATE TYPE "CheckInDeviceStatus" AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED', 'REVOKED', 'EXPIRED');

CREATE TABLE "CheckInDevice" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "eventId" TEXT,
    "eventSessionId" TEXT,
    "assignedStaffUserId" TEXT,
    "name" TEXT NOT NULL,
    "platform" TEXT,
    "publicKeyRef" TEXT,
    "status" "CheckInDeviceStatus" NOT NULL DEFAULT 'PENDING',
    "manifestVersion" INTEGER NOT NULL DEFAULT 0,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "expiresAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3),
    "approvedByUserId" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CheckInDevice_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "CheckInDevice_organizationId_idx" ON "CheckInDevice"("organizationId");
CREATE INDEX "CheckInDevice_eventId_idx" ON "CheckInDevice"("eventId");
CREATE INDEX "CheckInDevice_status_idx" ON "CheckInDevice"("status");

CREATE TABLE "CheckInManifest" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "eventSessionId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "validFrom" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "ticketCount" INTEGER NOT NULL,
    "signature" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CheckInManifest_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CheckInManifest_eventSessionId_version_key" ON "CheckInManifest"("eventSessionId", "version");
CREATE INDEX "CheckInManifest_organizationId_idx" ON "CheckInManifest"("organizationId");
CREATE INDEX "CheckInManifest_eventSessionId_idx" ON "CheckInManifest"("eventSessionId");
