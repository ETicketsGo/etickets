-- Draft booking-fee schedules: edited as a whole, published in one transaction.
--
-- Additive only. No existing FeeRule row is read or changed here: the live schedule stays
-- exactly as it is until an admin publishes a draft.

-- CreateEnum
CREATE TYPE "FeeScheduleDraftStatus" AS ENUM ('OPEN', 'PUBLISHED', 'DISCARDED');

-- CreateTable
CREATE TABLE "FeeScheduleDraft" (
    "id" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "status" "FeeScheduleDraftStatus" NOT NULL DEFAULT 'OPEN',
    "baseFingerprint" TEXT NOT NULL,
    "bands" JSONB NOT NULL,
    "version" INTEGER,
    "createdByUserId" TEXT NOT NULL,
    "updatedByUserId" TEXT,
    "publishedByUserId" TEXT,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FeeScheduleDraft_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FeeScheduleDraft_currency_version_key" ON "FeeScheduleDraft"("currency", "version");

-- CreateIndex
CREATE INDEX "FeeScheduleDraft_currency_status_idx" ON "FeeScheduleDraft"("currency", "status");
