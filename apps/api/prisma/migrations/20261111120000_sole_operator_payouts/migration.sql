-- Founder-operated payout controls. Additive only: new nullable columns and one boolean that
-- defaults to false, so every existing row keeps its meaning and nothing is rewritten.
ALTER TABLE "OrganizerPayoutAccount"
  ADD COLUMN "verificationMethod" TEXT,
  ADD COLUMN "verificationEvidence" TEXT,
  ADD COLUMN "ownerConfirmedAt" TIMESTAMP(3),
  ADD COLUMN "ownerConfirmedByUserId" TEXT,
  ADD COLUMN "ownerConfirmedVersion" INTEGER,
  ADD COLUMN "disputedAt" TIMESTAMP(3),
  ADD COLUMN "disputedByUserId" TEXT,
  ADD COLUMN "disputeReason" TEXT;

ALTER TABLE "Payout" ADD COLUMN "soleOperator" BOOLEAN NOT NULL DEFAULT false;
