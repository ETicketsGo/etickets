-- AlterTable
ALTER TABLE "NotificationDelivery" ADD COLUMN     "failureClass" TEXT;

-- CreateTable
CREATE TABLE "NotificationCertification" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "market" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'CODE_READY',
    "lastSuccessfulTestAt" TIMESTAMP(3),
    "lastSuccessfulCallbackAt" TIMESTAMP(3),
    "lastContractTestAt" TIMESTAMP(3),
    "certifiedByUserId" TEXT,
    "certifiedAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationCertification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "NotificationCertification_state_idx" ON "NotificationCertification"("state");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationCertification_provider_channel_market_key" ON "NotificationCertification"("provider", "channel", "market");

-- CreateIndex
CREATE INDEX "NotificationDelivery_failureClass_createdAt_idx" ON "NotificationDelivery"("failureClass", "createdAt");

-- AddForeignKey
ALTER TABLE "NotificationCertification" ADD CONSTRAINT "NotificationCertification_certifiedByUserId_fkey" FOREIGN KEY ("certifiedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

