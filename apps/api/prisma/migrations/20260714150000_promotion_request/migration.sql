-- CreateEnum
CREATE TYPE "PromotionStatus" AS ENUM ('PENDING_APPROVAL', 'APPROVED', 'APPLIED', 'REJECTED');

-- CreateTable
CREATE TABLE "PromotionRequest" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "fromEnv" "PaymentEnv" NOT NULL,
    "toEnv" "PaymentEnv" NOT NULL,
    "status" "PromotionStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
    "requiredApprovals" INTEGER NOT NULL DEFAULT 1,
    "report" JSONB NOT NULL,
    "approvals" JSONB NOT NULL DEFAULT '[]',
    "requestedByUserId" TEXT,
    "rejectedReason" TEXT,
    "appliedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PromotionRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PromotionRequest_toEnv_status_idx" ON "PromotionRequest"("toEnv", "status");

-- CreateIndex
CREATE INDEX "PromotionRequest_provider_idx" ON "PromotionRequest"("provider");
