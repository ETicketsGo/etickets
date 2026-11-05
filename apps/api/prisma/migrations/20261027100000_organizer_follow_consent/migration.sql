-- Organizer follows, per-organizer preferences, scoped communication consent and
-- per-organizer suppression. Additive only: four new tables and one enum. Nothing that
-- exists is altered, so it is safe to apply before the code that reads it.

-- CreateEnum
CREATE TYPE "OrganizerUpdateCadence" AS ENUM ('INSTANT', 'WEEKLY_DIGEST');

-- CreateTable
CREATE TABLE "OrganizerFollow" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrganizerFollow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganizerNotificationPreference" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "newEvents" BOOLEAN NOT NULL DEFAULT true,
    "earlyAccess" BOOLEAN NOT NULL DEFAULT false,
    "offers" BOOLEAN NOT NULL DEFAULT false,
    "cadence" "OrganizerUpdateCadence" NOT NULL DEFAULT 'INSTANT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizerNotificationPreference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommunicationConsent" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "subjectHash" TEXT NOT NULL,
    "organizationId" TEXT,
    "purpose" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'email',
    "granted" BOOLEAN NOT NULL,
    "source" TEXT NOT NULL,
    "policyVersion" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommunicationConsent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganizerSuppression" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "destinationHash" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "liftedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizerSuppression_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrganizerFollow_organizationId_createdAt_idx" ON "OrganizerFollow"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "OrganizerFollow_userId_createdAt_idx" ON "OrganizerFollow"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizerFollow_userId_organizationId_key" ON "OrganizerFollow"("userId", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizerNotificationPreference_userId_organizationId_key" ON "OrganizerNotificationPreference"("userId", "organizationId");

-- CreateIndex
CREATE INDEX "CommunicationConsent_subjectHash_purpose_organizationId_cre_idx" ON "CommunicationConsent"("subjectHash", "purpose", "organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "CommunicationConsent_userId_purpose_organizationId_createdA_idx" ON "CommunicationConsent"("userId", "purpose", "organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "CommunicationConsent_organizationId_purpose_createdAt_idx" ON "CommunicationConsent"("organizationId", "purpose", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizerSuppression_organizationId_channel_destinationHash_key" ON "OrganizerSuppression"("organizationId", "channel", "destinationHash");

-- AddForeignKey
ALTER TABLE "OrganizerFollow" ADD CONSTRAINT "OrganizerFollow_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizerFollow" ADD CONSTRAINT "OrganizerFollow_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizerNotificationPreference" ADD CONSTRAINT "OrganizerNotificationPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizerNotificationPreference" ADD CONSTRAINT "OrganizerNotificationPreference_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommunicationConsent" ADD CONSTRAINT "CommunicationConsent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

