-- Growth and monetization owner decisions (2026-10-27). Additive: no existing migration edited.

-- ── 1. Tax on the platform's own service to organizers ──────────────────────────────────
-- A TaxRule base of its own for plan subscriptions and email credit packs. Ticket pricing
-- never reads it; organizer billing reads only it. Nothing is rated by it until an owner
-- writes and activates a rule.
ALTER TYPE "TaxBase" ADD VALUE 'PLATFORM_SERVICES';

-- ── 2. Suppression scope: a complaint stops MARKETING, not tickets ──────────────────────
-- ALL       the destination does not work (hard bounce, invalid, provider block, SMS STOP):
--           nothing is sent to it.
-- MARKETING a spam complaint or "unsubscribe from all marketing email": every campaign and
--           platform marketing message skips it; essential transactional mail does not.
DROP INDEX "SuppressedDestination_channel_destinationHash_key";

ALTER TABLE "SuppressedDestination" ADD COLUMN "scope" TEXT NOT NULL DEFAULT 'ALL';

-- Complaints recorded before this change blocked every email, tickets included. They become
-- marketing-only. The rows are kept (reason, provider, source delivery, dates unchanged), so
-- the audit trail of why each address was suppressed survives.
UPDATE "SuppressedDestination" SET "scope" = 'MARKETING' WHERE "reason" = 'COMPLAINT';

ALTER TABLE "SuppressedDestination" ADD CONSTRAINT "SuppressedDestination_scope_known"
  CHECK ("scope" IN ('ALL', 'MARKETING'));

CREATE UNIQUE INDEX "SuppressedDestination_channel_destinationHash_scope_key" ON "SuppressedDestination"("channel", "destinationHash", "scope");

-- ── 3. Email credit pack prices (staff-set, unpublished by default) and purchases ───────
CREATE TABLE "CreditPackPrice" (
    "id" TEXT NOT NULL,
    "packCode" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "published" BOOLEAN NOT NULL DEFAULT false,
    "publishedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreditPackPrice_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CreditPackPurchase" (
    "id" TEXT NOT NULL,
    "purchaseRef" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "packCode" TEXT NOT NULL,
    "credits" INTEGER NOT NULL,
    "country" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "netMinor" INTEGER NOT NULL,
    "taxMinor" INTEGER NOT NULL,
    "totalMinor" INTEGER NOT NULL,
    "taxLines" JSONB NOT NULL,
    "taxMode" TEXT NOT NULL,
    "provider" "BillingProviderName" NOT NULL,
    "providerSessionRef" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreditPackPurchase_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CreditPackPrice_packCode_country_key" ON "CreditPackPrice"("packCode", "country");

CREATE UNIQUE INDEX "CreditPackPurchase_purchaseRef_key" ON "CreditPackPurchase"("purchaseRef");

CREATE INDEX "CreditPackPurchase_organizationId_createdAt_idx" ON "CreditPackPurchase"("organizationId", "createdAt");

ALTER TABLE "CreditPackPrice" ADD CONSTRAINT "CreditPackPrice_amount_positive" CHECK ("amountMinor" > 0);
-- Published means a date it was published.
ALTER TABLE "CreditPackPrice" ADD CONSTRAINT "CreditPackPrice_published_at"
  CHECK (NOT "published" OR "publishedAt" IS NOT NULL);
ALTER TABLE "CreditPackPurchase" ADD CONSTRAINT "CreditPackPurchase_amounts"
  CHECK ("netMinor" > 0 AND "taxMinor" >= 0 AND "totalMinor" = "netMinor" + "taxMinor" AND "credits" > 0);
ALTER TABLE "CreditPackPurchase" ADD CONSTRAINT "CreditPackPurchase_status_known"
  CHECK ("status" IN ('PENDING', 'PAID'));
ALTER TABLE "CreditPackPurchase" ADD CONSTRAINT "CreditPackPurchase_tax_mode_known"
  CHECK ("taxMode" IN ('MANUAL', 'PROVIDER_AUTOMATIC'));

-- ── 4. Invoice numbers per country series ───────────────────────────────────────────────
-- India: one series per Indian FINANCIAL year (1 April to 31 March, IST), within the 16
-- characters a GST invoice number may have: ETGB-2627-000001 is FY 2026-27, invoice 1.
-- Every other country: one series per calendar year (UTC), ETG-BIL-US-2026-000001.
-- The #503 shape (ETG-BIL-2026-000001) is replaced, not widened: no invoice has ever been
-- issued (billing has never been enabled in any environment, QA included), so no stored
-- number can fail the new check.
ALTER TABLE "OrganizerInvoice" DROP CONSTRAINT "OrganizerInvoice_number_shape";
ALTER TABLE "OrganizerInvoice" ADD CONSTRAINT "OrganizerInvoice_number_shape"
  CHECK (
    "number" IS NULL
    OR "number" ~ '^ETGB-[0-9]{4}-[0-9]{6,}$'
    OR "number" ~ '^ETG-BIL-[A-Z]{2}-[0-9]{4}-[0-9]{6,}$'
  );
