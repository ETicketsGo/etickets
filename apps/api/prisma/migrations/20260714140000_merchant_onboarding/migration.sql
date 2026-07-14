-- CreateEnum
CREATE TYPE "MerchantOnboardingStatus" AS ENUM ('DRAFT', 'PENDING_CONFIGURATION', 'PENDING_VERIFICATION', 'TESTING', 'READY_FOR_LIVE', 'ACTIVE', 'SUSPENDED', 'REJECTED');

-- CreateTable
CREATE TABLE "MerchantOnboarding" (
    "id" TEXT NOT NULL,
    "env" "PaymentEnv" NOT NULL,
    "organizationId" TEXT,
    "country" TEXT NOT NULL,
    "legalBusinessName" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "merchantType" TEXT NOT NULL DEFAULT 'STANDARD',
    "settlementCurrency" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "mode" "PaymentProviderMode" NOT NULL DEFAULT 'TEST',
    "accountIdentifier" TEXT,
    "secretKeyRef" TEXT,
    "webhookSecretRef" TEXT,
    "publicKey" TEXT,
    "settlementSchedule" TEXT NOT NULL DEFAULT 'T_PLUS_2',
    "payoutDestinationRef" TEXT,
    "webhookEndpointStatus" TEXT NOT NULL DEFAULT 'NOT_CONFIGURED',
    "verificationStatus" TEXT NOT NULL DEFAULT 'UNVERIFIED',
    "termsAcceptedAt" TIMESTAMP(3),
    "termsAcceptedBy" TEXT,
    "status" "MerchantOnboardingStatus" NOT NULL DEFAULT 'DRAFT',
    "activatedAt" TIMESTAMP(3),
    "suspendedAt" TIMESTAMP(3),
    "rejectedReason" TEXT,
    "merchantAccountId" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MerchantOnboarding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MerchantOnboarding_env_status_idx" ON "MerchantOnboarding"("env", "status");

-- CreateIndex
CREATE INDEX "MerchantOnboarding_organizationId_idx" ON "MerchantOnboarding"("organizationId");

-- CreateIndex
CREATE INDEX "MerchantOnboarding_provider_idx" ON "MerchantOnboarding"("provider");

-- AddForeignKey
ALTER TABLE "MerchantOnboarding" ADD CONSTRAINT "MerchantOnboarding_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;
