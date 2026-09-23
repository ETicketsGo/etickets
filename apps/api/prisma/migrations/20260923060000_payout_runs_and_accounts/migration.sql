-- Automatic settlement runs, somewhere to send the money, and a platform default that is a
-- decision rather than an unset variable.

-- 1) When the platform raises settlements by itself. Off until somebody turns it on.
ALTER TABLE "PayoutSetting" ADD COLUMN "autoGenerate" BOOLEAN;
ALTER TABLE "PayoutSetting" ADD COLUMN "runFrequency" TEXT;
ALTER TABLE "PayoutSetting" ADD COLUMN "runAnchorDay" INTEGER;
ALTER TABLE "PayoutSetting" ADD COLUMN "lastRunAt" TIMESTAMP(3);

-- 2) Where an organizer's money goes. The account number is ciphertext; what is in the clear
--    is only enough to recognise the account, never enough to move money.
CREATE TABLE "OrganizerPayoutAccount" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "holderName" TEXT NOT NULL,
    "bankName" TEXT NOT NULL,
    "bankCode" TEXT NOT NULL,
    "accountLast4" TEXT NOT NULL,
    "accountCipher" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3),
    "verifiedByUserId" TEXT,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OrganizerPayoutAccount_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OrganizerPayoutAccount_organizationId_currency_key"
    ON "OrganizerPayoutAccount"("organizationId", "currency");
CREATE INDEX "OrganizerPayoutAccount_organizationId_idx"
    ON "OrganizerPayoutAccount"("organizationId");

ALTER TABLE "OrganizerPayoutAccount" ADD CONSTRAINT "OrganizerPayoutAccount_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 3) The platform's own terms, written down. Seven days after the last show, no minimum.
--    It was already the effective behaviour through a deployment default; making it a row
--    means the console shows a decision somebody made rather than an absence.
INSERT INTO "PayoutSetting" ("id", "organizationId", "holdDays", "autoGenerate", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, NULL, 7, false, NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM "PayoutSetting" WHERE "organizationId" IS NULL);
