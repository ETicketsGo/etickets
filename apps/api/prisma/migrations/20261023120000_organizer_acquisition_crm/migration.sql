-- Organizer acquisition (sales CRM): prospects, outreach logs, follow-ups and teams.
--
-- PURELY ADDITIVE. Six new enums, six new tables, their indexes and foreign keys, and two
-- team rows. No existing table is altered: the only references out of these tables point AT
-- "User" and "Organization" (foreign keys on the NEW tables), and nothing here updates or
-- deletes a row anywhere else. An older API never reads these tables, so it keeps working
-- against a migrated database, and rolling the API back needs no down-migration.
--
-- "CrmLead"."organizationId" is UNIQUE: one organization can be the outcome of at most one
-- lead. ON DELETE SET NULL, so removing an organization never removes the sales history.
--
-- "CrmFollowUp"."openKey" is UNIQUE and set only while a follow-up is OPEN, so two open
-- follow-ups for the same lead, owner and day cannot both exist even under a race. NULLs do
-- not collide, so done and cancelled follow-ups are unaffected.

-- CreateEnum
CREATE TYPE "CrmLeadStage" AS ENUM ('IDENTIFIED', 'CONTACTED', 'RESPONDED_INTERESTED', 'DEMO_SCHEDULED', 'DEMO_COMPLETED', 'NEGOTIATION', 'ONBOARDING', 'ACTIVATED', 'LOST');

-- CreateEnum
CREATE TYPE "CrmLeadPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "CrmActivityType" AS ENUM ('EMAIL', 'CALL', 'LINKEDIN', 'MEETING', 'VISIT');

-- CreateEnum
CREATE TYPE "CrmActivityOutcome" AS ENUM ('NO_RESPONSE', 'LEFT_MESSAGE', 'CONNECTED', 'INTERESTED', 'NOT_INTERESTED', 'DEMO_BOOKED', 'FOLLOW_UP_NEEDED', 'OTHER');

-- CreateEnum
CREATE TYPE "CrmFollowUpStatus" AS ENUM ('OPEN', 'DONE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CrmTeamRole" AS ENUM ('AGENT', 'MANAGER');

-- CreateTable
CREATE TABLE "CrmTeam" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmTeam_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmTeamMember" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "CrmTeamRole" NOT NULL DEFAULT 'AGENT',
    "addedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmTeamMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmLead" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "organizationName" TEXT NOT NULL,
    "category" TEXT,
    "website" TEXT,
    "city" TEXT,
    "state" TEXT,
    "timezone" TEXT,
    "contactName" TEXT,
    "contactTitle" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "socialLinks" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "source" TEXT NOT NULL,
    "priority" "CrmLeadPriority" NOT NULL DEFAULT 'MEDIUM',
    "notes" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "nameKey" TEXT,
    "domainKey" TEXT,
    "emailKey" TEXT,
    "phoneKey" TEXT,
    "stage" "CrmLeadStage" NOT NULL DEFAULT 'IDENTIFIED',
    "stageChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lostReason" TEXT,
    "assignedToUserId" TEXT,
    "createdByUserId" TEXT,
    "organizationId" TEXT,
    "linkedAt" TIMESTAMP(3),
    "linkedByUserId" TEXT,
    "nextFollowUpAt" TIMESTAMP(3),
    "lastActivityAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmLead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmLeadStageChange" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "fromStage" "CrmLeadStage",
    "toStage" "CrmLeadStage" NOT NULL,
    "changedByUserId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrmLeadStageChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmActivity" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "type" "CrmActivityType" NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "outcome" "CrmActivityOutcome",
    "notes" TEXT,
    "responsibleUserId" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrmActivity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmFollowUp" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "title" TEXT NOT NULL,
    "notes" TEXT,
    "status" "CrmFollowUpStatus" NOT NULL DEFAULT 'OPEN',
    "openKey" TEXT,
    "activityId" TEXT,
    "createdByUserId" TEXT,
    "completedAt" TIMESTAMP(3),
    "completedByUserId" TEXT,
    "completionNote" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmFollowUp_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CrmTeam_key_key" ON "CrmTeam"("key");

-- CreateIndex
CREATE INDEX "CrmTeam_country_idx" ON "CrmTeam"("country");

-- CreateIndex
CREATE INDEX "CrmTeamMember_userId_idx" ON "CrmTeamMember"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "CrmTeamMember_teamId_userId_key" ON "CrmTeamMember"("teamId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "CrmLead_organizationId_key" ON "CrmLead"("organizationId");

-- CreateIndex
CREATE INDEX "CrmLead_teamId_stage_idx" ON "CrmLead"("teamId", "stage");

-- CreateIndex
CREATE INDEX "CrmLead_assignedToUserId_stage_idx" ON "CrmLead"("assignedToUserId", "stage");

-- CreateIndex
CREATE INDEX "CrmLead_country_stage_idx" ON "CrmLead"("country", "stage");

-- CreateIndex
CREATE INDEX "CrmLead_nameKey_idx" ON "CrmLead"("nameKey");

-- CreateIndex
CREATE INDEX "CrmLead_domainKey_idx" ON "CrmLead"("domainKey");

-- CreateIndex
CREATE INDEX "CrmLead_emailKey_idx" ON "CrmLead"("emailKey");

-- CreateIndex
CREATE INDEX "CrmLead_phoneKey_idx" ON "CrmLead"("phoneKey");

-- CreateIndex
CREATE INDEX "CrmLead_nextFollowUpAt_idx" ON "CrmLead"("nextFollowUpAt");

-- CreateIndex
CREATE INDEX "CrmLead_createdAt_idx" ON "CrmLead"("createdAt");

-- CreateIndex
CREATE INDEX "CrmLead_source_idx" ON "CrmLead"("source");

-- CreateIndex
CREATE INDEX "CrmLeadStageChange_leadId_createdAt_idx" ON "CrmLeadStageChange"("leadId", "createdAt");

-- CreateIndex
CREATE INDEX "CrmLeadStageChange_toStage_createdAt_idx" ON "CrmLeadStageChange"("toStage", "createdAt");

-- CreateIndex
CREATE INDEX "CrmActivity_leadId_occurredAt_idx" ON "CrmActivity"("leadId", "occurredAt");

-- CreateIndex
CREATE INDEX "CrmActivity_responsibleUserId_occurredAt_idx" ON "CrmActivity"("responsibleUserId", "occurredAt");

-- CreateIndex
CREATE INDEX "CrmActivity_occurredAt_idx" ON "CrmActivity"("occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "CrmFollowUp_openKey_key" ON "CrmFollowUp"("openKey");

-- CreateIndex
CREATE INDEX "CrmFollowUp_ownerUserId_status_dueAt_idx" ON "CrmFollowUp"("ownerUserId", "status", "dueAt");

-- CreateIndex
CREATE INDEX "CrmFollowUp_leadId_status_idx" ON "CrmFollowUp"("leadId", "status");

-- CreateIndex
CREATE INDEX "CrmFollowUp_status_dueAt_idx" ON "CrmFollowUp"("status", "dueAt");

-- AddForeignKey
ALTER TABLE "CrmTeamMember" ADD CONSTRAINT "CrmTeamMember_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "CrmTeam"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmTeamMember" ADD CONSTRAINT "CrmTeamMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmLead" ADD CONSTRAINT "CrmLead_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "CrmTeam"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmLead" ADD CONSTRAINT "CrmLead_assignedToUserId_fkey" FOREIGN KEY ("assignedToUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmLead" ADD CONSTRAINT "CrmLead_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmLead" ADD CONSTRAINT "CrmLead_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmLeadStageChange" ADD CONSTRAINT "CrmLeadStageChange_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "CrmLead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmLeadStageChange" ADD CONSTRAINT "CrmLeadStageChange_changedByUserId_fkey" FOREIGN KEY ("changedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmActivity" ADD CONSTRAINT "CrmActivity_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "CrmLead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmActivity" ADD CONSTRAINT "CrmActivity_responsibleUserId_fkey" FOREIGN KEY ("responsibleUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmFollowUp" ADD CONSTRAINT "CrmFollowUp_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "CrmLead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmFollowUp" ADD CONSTRAINT "CrmFollowUp_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The two teams the acquisition desk starts with. Members are added in the console; nobody
-- is placed in a team, and nobody is granted anything, by this migration.
INSERT INTO "CrmTeam" ("id", "key", "name", "country", "active", "createdAt", "updatedAt")
VALUES
  ('crmteam_in', 'IN', 'India', 'IN', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('crmteam_us', 'US', 'United States', 'US', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;
