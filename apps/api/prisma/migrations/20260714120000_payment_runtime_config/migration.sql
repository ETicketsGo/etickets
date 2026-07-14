-- CreateEnum
CREATE TYPE "PaymentEnv" AS ENUM ('LOCAL', 'DEV', 'QA', 'UAT', 'STAGING', 'PRODUCTION');

-- CreateEnum
CREATE TYPE "PaymentProviderMode" AS ENUM ('DUMMY', 'TEST', 'LIVE');

-- CreateTable
CREATE TABLE "PaymentProviderConfig" (
    "id" TEXT NOT NULL,
    "env" "PaymentEnv" NOT NULL,
    "provider" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "mode" "PaymentProviderMode" NOT NULL DEFAULT 'TEST',
    "publicKey" TEXT,
    "secretKeyRef" TEXT,
    "webhookSecretRef" TEXT,
    "apiBaseUrl" TEXT,
    "timeoutMs" INTEGER NOT NULL DEFAULT 15000,
    "maxRetries" INTEGER NOT NULL DEFAULT 2,
    "retryBackoffMs" INTEGER NOT NULL DEFAULT 500,
    "circuitFailureThreshold" INTEGER NOT NULL DEFAULT 5,
    "circuitCooldownMs" INTEGER NOT NULL DEFAULT 30000,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentProviderConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MerchantAccount" (
    "id" TEXT NOT NULL,
    "configId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "country" TEXT,
    "currency" TEXT,
    "merchantIdRef" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MerchantAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentRoute" (
    "id" TEXT NOT NULL,
    "env" "PaymentEnv" NOT NULL,
    "country" TEXT NOT NULL DEFAULT '*',
    "currency" TEXT NOT NULL DEFAULT '*',
    "method" TEXT NOT NULL DEFAULT '*',
    "provider" TEXT NOT NULL,
    "failoverProvider" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentRoute_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PaymentProviderConfig_env_enabled_idx" ON "PaymentProviderConfig"("env", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentProviderConfig_env_provider_key" ON "PaymentProviderConfig"("env", "provider");

-- CreateIndex
CREATE INDEX "MerchantAccount_configId_active_idx" ON "MerchantAccount"("configId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "MerchantAccount_configId_country_currency_key" ON "MerchantAccount"("configId", "country", "currency");

-- CreateIndex
CREATE INDEX "PaymentRoute_env_active_idx" ON "PaymentRoute"("env", "active");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentRoute_env_country_currency_method_key" ON "PaymentRoute"("env", "country", "currency", "method");

-- AddForeignKey
ALTER TABLE "MerchantAccount" ADD CONSTRAINT "MerchantAccount_configId_fkey" FOREIGN KEY ("configId") REFERENCES "PaymentProviderConfig"("id") ON DELETE CASCADE ON UPDATE CASCADE;
