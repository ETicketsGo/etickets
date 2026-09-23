-- Settlement terms an admin can change, evidence for a paid payout, and the one number a
-- refund was missing.

-- 1) How settlements run: one row per scope. NULL organizationId is the platform default;
--    every field is nullable, and null means "inherit".
CREATE TABLE "PayoutSetting" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "holdDays" INTEGER,
    "minPayoutMinor" JSONB,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PayoutSetting_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PayoutSetting_organizationId_key" ON "PayoutSetting"("organizationId");

ALTER TABLE "PayoutSetting" ADD CONSTRAINT "PayoutSetting_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PayoutSetting" ADD CONSTRAINT "PayoutSetting_updatedByUserId_fkey"
    FOREIGN KEY ("updatedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 2) A payout you can reconcile against a bank statement, and one that can fail.
ALTER TABLE "Payout" ADD COLUMN "paidReference" TEXT;
ALTER TABLE "Payout" ADD COLUMN "note" TEXT;
ALTER TABLE "Payout" ADD COLUMN "failureReason" TEXT;

-- 3) The tax a refund returns that was ADDED to the price rather than inside it. Zero is
--    correct for every existing row: the markets that have refunded so far charge tax
--    inclusive, where the whole refund is the organizer's money.
ALTER TABLE "Refund" ADD COLUMN "taxAddedMinor" INTEGER NOT NULL DEFAULT 0;
