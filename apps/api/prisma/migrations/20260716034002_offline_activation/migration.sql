-- CreateEnum
CREATE TYPE "OfflineActivationState" AS ENUM ('ACTIVE', 'REVOKED', 'SUPERSEDED');

-- CreateTable
CREATE TABLE "OfflineActivation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "eventSessionId" TEXT NOT NULL,
    "deviceIds" TEXT[],
    "state" "OfflineActivationState" NOT NULL DEFAULT 'ACTIVE',
    "reason" TEXT NOT NULL,
    "evidenceSnapshot" JSONB NOT NULL,
    "approvedByUserId" TEXT NOT NULL,
    "approvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedByUserId" TEXT,
    "revokedAt" TIMESTAMP(3),
    "revokeReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OfflineActivation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OfflineActivation_organizationId_eventSessionId_state_idx" ON "OfflineActivation"("organizationId", "eventSessionId", "state");
