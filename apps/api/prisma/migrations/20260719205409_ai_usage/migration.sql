-- CreateTable
CREATE TABLE "AiUsage" (
    "id" TEXT NOT NULL,
    "feature" TEXT NOT NULL,
    "promptKey" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "latencyMs" INTEGER NOT NULL DEFAULT 0,
    "tokensIn" INTEGER NOT NULL DEFAULT 0,
    "tokensOut" INTEGER NOT NULL DEFAULT 0,
    "costMinor" INTEGER NOT NULL DEFAULT 0,
    "redactions" INTEGER NOT NULL DEFAULT 0,
    "organizationId" TEXT,
    "actorUserId" TEXT,
    "correlationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiUsage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiUsage_feature_idx" ON "AiUsage"("feature");

-- CreateIndex
CREATE INDEX "AiUsage_status_idx" ON "AiUsage"("status");

-- CreateIndex
CREATE INDEX "AiUsage_createdAt_idx" ON "AiUsage"("createdAt");
