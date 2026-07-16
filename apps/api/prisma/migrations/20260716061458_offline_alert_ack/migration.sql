-- CreateTable
CREATE TABLE "OfflineAlertAck" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "eventSessionId" TEXT NOT NULL,
    "alertKey" TEXT NOT NULL,
    "severityAtAck" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "acknowledgedByUserId" TEXT NOT NULL,
    "acknowledgedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OfflineAlertAck_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OfflineAlertAck_organizationId_eventSessionId_idx" ON "OfflineAlertAck"("organizationId", "eventSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "OfflineAlertAck_eventSessionId_alertKey_key" ON "OfflineAlertAck"("eventSessionId", "alertKey");
