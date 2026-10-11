-- Payout bank accounts: a version history, a reject decision, and a database-level maker-checker.
--
-- Forward-only and additive. Nothing is dropped or rewritten in place; no payout, settlement or
-- ledger table is touched, and no payout is generated, held or released by this migration.
--
-- WHY: a save used to overwrite the one row silently, so there was no record of what an
-- account looked like before a change, and the person who saved an account could also be the
-- one who marked it checked. The history table keeps MASKED details only (no ciphertext column
-- exists on it, on purpose), and the check constraint makes "verified by the person who saved
-- it" impossible even for a code path that forgets the rule.

CREATE TYPE "PayoutAccountVersionStatus" AS ENUM ('PENDING_VERIFICATION', 'VERIFIED', 'REJECTED', 'SUPERSEDED');

ALTER TABLE "OrganizerPayoutAccount"
    ADD COLUMN "rejectedAt" TIMESTAMP(3),
    ADD COLUMN "rejectedByUserId" TEXT,
    ADD COLUMN "rejectionReason" TEXT,
    ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

CREATE TABLE "OrganizerPayoutAccountVersion" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "holderName" TEXT NOT NULL,
    "bankName" TEXT NOT NULL,
    "bankCode" TEXT NOT NULL,
    "accountLast4" TEXT NOT NULL,
    "changedFields" TEXT[],
    "savedByUserId" TEXT,
    "status" "PayoutAccountVersionStatus" NOT NULL DEFAULT 'PENDING_VERIFICATION',
    "decidedAt" TIMESTAMP(3),
    "decidedByUserId" TEXT,
    "decisionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrganizerPayoutAccountVersion_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "OrganizerPayoutAccountVersion_organizationId_currency_versi_idx"
    ON "OrganizerPayoutAccountVersion"("organizationId", "currency", "version");
CREATE UNIQUE INDEX "OrganizerPayoutAccountVersion_accountId_version_key"
    ON "OrganizerPayoutAccountVersion"("accountId", "version");

ALTER TABLE "OrganizerPayoutAccountVersion"
    ADD CONSTRAINT "OrganizerPayoutAccountVersion_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "OrganizerPayoutAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Every account that exists today becomes version 1 of its own history, so the history never
-- starts with a gap. A row that was already verified stays verified: this migration decides
-- nothing about money. (md5 of the account id keeps the backfill repeatable and needs no
-- extension.)
INSERT INTO "OrganizerPayoutAccountVersion"
    ("id", "accountId", "organizationId", "currency", "version", "holderName", "bankName",
     "bankCode", "accountLast4", "changedFields", "savedByUserId", "status", "decidedAt",
     "decidedByUserId", "createdAt")
SELECT 'pav_' || md5("id"), "id", "organizationId", "currency", 1, "holderName", "bankName",
       "bankCode", "accountLast4", ARRAY['initial']::TEXT[], "updatedByUserId",
       CASE WHEN "verifiedAt" IS NULL THEN 'PENDING_VERIFICATION'::"PayoutAccountVersionStatus"
            ELSE 'VERIFIED'::"PayoutAccountVersionStatus" END,
       "verifiedAt", "verifiedByUserId", "createdAt"
FROM "OrganizerPayoutAccount";

-- Maker-checker at the database. NOT VALID: rows verified before this rule existed are
-- grandfathered (they were never checked against it), but every new or changed row must satisfy
-- it. A NULL on either side means the maker is unknown (a legacy row), which the service rule
-- handles separately.
ALTER TABLE "OrganizerPayoutAccount" ADD CONSTRAINT "OrganizerPayoutAccount_checker_not_maker"
    CHECK ("verifiedAt" IS NULL OR "verifiedByUserId" IS NULL OR "updatedByUserId" IS NULL
           OR "verifiedByUserId" <> "updatedByUserId") NOT VALID;

-- A row is verified or rejected, never both.
ALTER TABLE "OrganizerPayoutAccount" ADD CONSTRAINT "OrganizerPayoutAccount_not_verified_and_rejected"
    CHECK ("verifiedAt" IS NULL OR "rejectedAt" IS NULL);
