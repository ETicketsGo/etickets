-- Organizer billing and entitlements: the foundation (catalogue, accounts, subscriptions,
-- invoices, payments, adjustments, billing webhook events, entitlement overrides, usage ledger).
--
-- Additive and backward compatible:
--   * new enums and new tables only. No existing table, column, constraint or row changes, and no
--     existing model gains a relation (organizationId / ...UserId columns are plain ids).
--   * no rows are written. The catalogue (plans, prices, plan entitlements) is loaded only by an
--     explicit admin action (POST /admin/billing/catalog/load-provisional), never here.
--   * nothing reads these tables until the new API is deployed; with no rows, every organization
--     resolves to the FREE plan, which is what every organization has today.
-- Rollback: the previous API never reads these tables. Dropping them is never required to roll
-- back; if wanted, drop the tables, then the functions, then the enums.

-- CreateEnum
CREATE TYPE "BillingPlanCode" AS ENUM ('FREE', 'PRO', 'PREMIUM');

-- CreateEnum
CREATE TYPE "BillingInterval" AS ENUM ('MONTH', 'YEAR');

-- CreateEnum
CREATE TYPE "BillingProviderName" AS ENUM ('NONE', 'MOCK', 'STRIPE_BILLING', 'RAZORPAY_BILLING');

-- CreateEnum
CREATE TYPE "OrganizerSubscriptionStatus" AS ENUM ('TRIALING', 'ACTIVE', 'PAST_DUE', 'GRACE', 'CANCELLED', 'EXPIRED', 'COMPLIMENTARY');

-- CreateEnum
CREATE TYPE "OrganizerSubscriptionSource" AS ENUM ('PROVIDER', 'ADMIN_COMPLIMENTARY', 'TRIAL');

-- CreateEnum
CREATE TYPE "OrganizerInvoiceStatus" AS ENUM ('DRAFT', 'OPEN', 'PAID', 'VOID', 'REFUNDED');

-- CreateEnum
CREATE TYPE "BillingPaymentStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "BillingAdjustmentKind" AS ENUM ('CREDIT_NOTE', 'REFUND', 'DISCOUNT');

-- CreateEnum
CREATE TYPE "BillingWebhookStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED');

-- CreateEnum
CREATE TYPE "UsageLedgerReason" AS ENUM ('CONSUMPTION', 'CREDIT_GRANT', 'CREDIT_REVERSAL', 'ADJUSTMENT');

-- CreateTable
CREATE TABLE "BillingPlan" (
    "id" TEXT NOT NULL,
    "code" "BillingPlanCode" NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingPrice" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "interval" "BillingInterval" NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "trialDays" INTEGER,
    "providerPriceRefTest" TEXT,
    "providerPriceRefLive" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "activeKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingPrice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlanEntitlement" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "boolValue" BOOLEAN,
    "intValue" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlanEntitlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganizerBillingAccount" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "provider" "BillingProviderName" NOT NULL DEFAULT 'NONE',
    "providerCustomerRef" TEXT,
    "taxId" TEXT,
    "billingEmail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizerBillingAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganizerSubscription" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "priceId" TEXT,
    "status" "OrganizerSubscriptionStatus" NOT NULL,
    "source" "OrganizerSubscriptionSource" NOT NULL,
    "currentPeriodStart" TIMESTAMP(3) NOT NULL,
    "currentPeriodEnd" TIMESTAMP(3),
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "trialEndsAt" TIMESTAMP(3),
    "graceEndsAt" TIMESTAMP(3),
    "scheduledPlanId" TEXT,
    "providerSubscriptionRef" TEXT,
    "currentKey" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "grantedByUserId" TEXT,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizerSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganizerInvoice" (
    "id" TEXT NOT NULL,
    "number" TEXT,
    "accountId" TEXT NOT NULL,
    "subscriptionId" TEXT,
    "status" "OrganizerInvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "subtotalMinor" INTEGER NOT NULL,
    "taxMinor" INTEGER NOT NULL DEFAULT 0,
    "totalMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "lines" JSONB NOT NULL,
    "periodStart" TIMESTAMP(3),
    "periodEnd" TIMESTAMP(3),
    "issuedAt" TIMESTAMP(3),
    "documentJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizerInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingPayment" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "invoiceId" TEXT,
    "provider" "BillingProviderName" NOT NULL,
    "providerPaymentRef" TEXT,
    "amountMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "status" "BillingPaymentStatus" NOT NULL,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingAdjustment" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "kind" "BillingAdjustmentKind" NOT NULL,
    "invoiceId" TEXT,
    "subscriptionId" TEXT,
    "amountMinor" INTEGER,
    "percentOffBps" INTEGER,
    "currency" TEXT,
    "startsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endsAt" TIMESTAMP(3),
    "reason" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillingAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingWebhookEvent" (
    "id" TEXT NOT NULL,
    "provider" "BillingProviderName" NOT NULL,
    "providerEventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "signatureVerified" BOOLEAN NOT NULL DEFAULT false,
    "payload" JSONB NOT NULL,
    "status" "BillingWebhookStatus" NOT NULL DEFAULT 'RECEIVED',
    "accountId" TEXT,
    "error" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "BillingWebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EntitlementOverride" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "boolValue" BOOLEAN,
    "intValue" INTEGER,
    "startsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endsAt" TIMESTAMP(3),
    "reason" TEXT NOT NULL,
    "grantedByUserId" TEXT NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokedByUserId" TEXT,
    "revokeReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EntitlementOverride_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageLedger" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "delta" INTEGER NOT NULL,
    "reason" "UsageLedgerReason" NOT NULL,
    "refType" TEXT,
    "refId" TEXT,
    "periodKey" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "actorUserId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsageLedger_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BillingPlan_code_key" ON "BillingPlan"("code");

-- CreateIndex
CREATE UNIQUE INDEX "BillingPrice_activeKey_key" ON "BillingPrice"("activeKey");

-- CreateIndex
CREATE INDEX "BillingPrice_planId_country_interval_idx" ON "BillingPrice"("planId", "country", "interval");

-- CreateIndex
CREATE INDEX "BillingPrice_country_active_idx" ON "BillingPrice"("country", "active");

-- CreateIndex
CREATE UNIQUE INDEX "PlanEntitlement_planId_key_key" ON "PlanEntitlement"("planId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizerBillingAccount_organizationId_key" ON "OrganizerBillingAccount"("organizationId");

-- CreateIndex
CREATE INDEX "OrganizerBillingAccount_country_idx" ON "OrganizerBillingAccount"("country");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizerSubscription_providerSubscriptionRef_key" ON "OrganizerSubscription"("providerSubscriptionRef");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizerSubscription_currentKey_key" ON "OrganizerSubscription"("currentKey");

-- CreateIndex
CREATE INDEX "OrganizerSubscription_accountId_createdAt_idx" ON "OrganizerSubscription"("accountId", "createdAt");

-- CreateIndex
CREATE INDEX "OrganizerSubscription_status_currentPeriodEnd_idx" ON "OrganizerSubscription"("status", "currentPeriodEnd");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizerInvoice_number_key" ON "OrganizerInvoice"("number");

-- CreateIndex
CREATE INDEX "OrganizerInvoice_accountId_createdAt_idx" ON "OrganizerInvoice"("accountId", "createdAt");

-- CreateIndex
CREATE INDEX "OrganizerInvoice_status_idx" ON "OrganizerInvoice"("status");

-- CreateIndex
CREATE INDEX "BillingPayment_accountId_createdAt_idx" ON "BillingPayment"("accountId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "BillingPayment_provider_providerPaymentRef_key" ON "BillingPayment"("provider", "providerPaymentRef");

-- CreateIndex
CREATE INDEX "BillingAdjustment_accountId_createdAt_idx" ON "BillingAdjustment"("accountId", "createdAt");

-- CreateIndex
CREATE INDEX "BillingWebhookEvent_status_receivedAt_idx" ON "BillingWebhookEvent"("status", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "BillingWebhookEvent_provider_providerEventId_key" ON "BillingWebhookEvent"("provider", "providerEventId");

-- CreateIndex
CREATE INDEX "EntitlementOverride_organizationId_key_idx" ON "EntitlementOverride"("organizationId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "UsageLedger_idempotencyKey_key" ON "UsageLedger"("idempotencyKey");

-- CreateIndex
CREATE INDEX "UsageLedger_organizationId_key_periodKey_idx" ON "UsageLedger"("organizationId", "key", "periodKey");

-- AddForeignKey
ALTER TABLE "BillingPrice" ADD CONSTRAINT "BillingPrice_planId_fkey" FOREIGN KEY ("planId") REFERENCES "BillingPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanEntitlement" ADD CONSTRAINT "PlanEntitlement_planId_fkey" FOREIGN KEY ("planId") REFERENCES "BillingPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizerSubscription" ADD CONSTRAINT "OrganizerSubscription_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "OrganizerBillingAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizerSubscription" ADD CONSTRAINT "OrganizerSubscription_planId_fkey" FOREIGN KEY ("planId") REFERENCES "BillingPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizerSubscription" ADD CONSTRAINT "OrganizerSubscription_priceId_fkey" FOREIGN KEY ("priceId") REFERENCES "BillingPrice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizerSubscription" ADD CONSTRAINT "OrganizerSubscription_scheduledPlanId_fkey" FOREIGN KEY ("scheduledPlanId") REFERENCES "BillingPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizerInvoice" ADD CONSTRAINT "OrganizerInvoice_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "OrganizerBillingAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizerInvoice" ADD CONSTRAINT "OrganizerInvoice_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "OrganizerSubscription"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingPayment" ADD CONSTRAINT "BillingPayment_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "OrganizerBillingAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingPayment" ADD CONSTRAINT "BillingPayment_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "OrganizerInvoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingAdjustment" ADD CONSTRAINT "BillingAdjustment_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "OrganizerBillingAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingAdjustment" ADD CONSTRAINT "BillingAdjustment_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "OrganizerInvoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingAdjustment" ADD CONSTRAINT "BillingAdjustment_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "OrganizerSubscription"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Invariants the database holds, whatever writes the row ──────────────────────────────

-- Money is never negative, and a total is subtotal plus tax.
ALTER TABLE "BillingPrice" ADD CONSTRAINT "BillingPrice_amount_nonnegative" CHECK ("amountMinor" >= 0);
ALTER TABLE "BillingPrice" ADD CONSTRAINT "BillingPrice_trial_days_range" CHECK ("trialDays" IS NULL OR ("trialDays" >= 0 AND "trialDays" <= 365));
ALTER TABLE "OrganizerInvoice" ADD CONSTRAINT "OrganizerInvoice_amounts" CHECK ("subtotalMinor" >= 0 AND "taxMinor" >= 0 AND "totalMinor" = "subtotalMinor" + "taxMinor");
ALTER TABLE "BillingPayment" ADD CONSTRAINT "BillingPayment_amount_nonnegative" CHECK ("amountMinor" >= 0);
ALTER TABLE "BillingAdjustment" ADD CONSTRAINT "BillingAdjustment_values" CHECK (
  ("amountMinor" IS NULL OR "amountMinor" >= 0)
  AND ("percentOffBps" IS NULL OR ("percentOffBps" > 0 AND "percentOffBps" <= 10000))
);

-- An invoice number has one shape, and only an issued invoice carries one.
ALTER TABLE "OrganizerInvoice" ADD CONSTRAINT "OrganizerInvoice_number_shape"
  CHECK ("number" IS NULL OR "number" ~ '^ETG-BIL-[0-9]{4}-[0-9]{6,}$');
ALTER TABLE "OrganizerInvoice" ADD CONSTRAINT "OrganizerInvoice_number_when_issued"
  CHECK (("status" = 'DRAFT') = ("number" IS NULL));

-- An override states exactly one value.
ALTER TABLE "EntitlementOverride" ADD CONSTRAINT "EntitlementOverride_one_value"
  CHECK (("boolValue" IS NULL) <> ("intValue" IS NULL));
ALTER TABLE "EntitlementOverride" ADD CONSTRAINT "EntitlementOverride_window"
  CHECK ("endsAt" IS NULL OR "endsAt" > "startsAt");

-- A ledger row moves something.
ALTER TABLE "UsageLedger" ADD CONSTRAINT "UsageLedger_delta_nonzero" CHECK ("delta" <> 0);

-- The usage ledger is append-only: balances are derived from it, so an edited row would be a
-- silently changed balance. A correction is a new row (reason ADJUSTMENT or CREDIT_REVERSAL).
CREATE OR REPLACE FUNCTION "usage_ledger_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'UsageLedger is append-only: % is not allowed', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "UsageLedger_append_only"
  BEFORE UPDATE OR DELETE ON "UsageLedger"
  FOR EACH ROW EXECUTE FUNCTION "usage_ledger_append_only"();

-- An issued invoice is never deleted, and its number never changes: the series must stay
-- gapless. A mistake is corrected with a credit note (BillingAdjustment) or VOID status.
CREATE OR REPLACE FUNCTION "organizer_invoice_number_frozen"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."number" IS NOT NULL THEN
      RAISE EXCEPTION 'An issued invoice (%) cannot be deleted', OLD."number";
    END IF;
    RETURN OLD;
  END IF;
  IF OLD."number" IS NOT NULL AND NEW."number" IS DISTINCT FROM OLD."number" THEN
    RAISE EXCEPTION 'An issued invoice number (%) cannot change', OLD."number";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "OrganizerInvoice_number_frozen"
  BEFORE UPDATE OR DELETE ON "OrganizerInvoice"
  FOR EACH ROW EXECUTE FUNCTION "organizer_invoice_number_frozen"();

-- Invoice numbers come from the counter the support references already use
-- ("etg_next_reference_value", migration 20261025120000), scope 'BIL-<YEAR>'. The API takes the
-- number inside the transaction that issues the invoice, so a rollback gives it back.
