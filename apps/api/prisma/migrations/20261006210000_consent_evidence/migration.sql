-- AlterTable
-- Additive and nullable: every existing consent row stays valid and unchanged. Older rows
-- simply have no country, policy version or number recorded, which is the truth about them.
ALTER TABLE "MarketingConsent" ADD COLUMN     "country" TEXT,
ADD COLUMN     "policyVersion" TEXT,
ADD COLUMN     "phone" TEXT;
