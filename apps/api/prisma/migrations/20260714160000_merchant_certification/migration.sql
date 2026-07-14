-- CreateEnum
CREATE TYPE "CertificationResult" AS ENUM ('PASS', 'PARTIAL', 'FAIL');

-- CreateTable
CREATE TABLE "MerchantCertification" (
    "id" TEXT NOT NULL,
    "merchantOnboardingId" TEXT,
    "env" "PaymentEnv" NOT NULL,
    "provider" TEXT NOT NULL,
    "result" "CertificationResult" NOT NULL,
    "steps" JSONB NOT NULL,
    "passedCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "operator" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MerchantCertification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MerchantCertification_merchantOnboardingId_idx" ON "MerchantCertification"("merchantOnboardingId");

-- CreateIndex
CREATE INDEX "MerchantCertification_env_provider_idx" ON "MerchantCertification"("env", "provider");
