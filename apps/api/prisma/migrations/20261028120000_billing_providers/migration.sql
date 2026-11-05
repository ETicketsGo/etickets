-- Organizer billing providers: Stripe Billing (US) and Razorpay Subscriptions (IN).
--
-- Purely additive: nullable columns, columns with defaults, two unique indexes on columns that
-- are NULL on every existing row, and one notification type. An older API ignores all of it and
-- keeps working against a migrated database. Ticket payment tables are not touched.

ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'BILLING_PAYMENT_FAILED';

-- A dispute (chargeback) on a billing payment flags the account for staff.
ALTER TABLE "OrganizerBillingAccount" ADD COLUMN "disputedAt" TIMESTAMP(3);
ALTER TABLE "OrganizerBillingAccount" ADD COLUMN "disputeRef" TEXT;
-- Provider events are routed to an account by its provider customer.
CREATE UNIQUE INDEX "OrganizerBillingAccount_provider_providerCustomerRef_key"
  ON "OrganizerBillingAccount"("provider", "providerCustomerRef");

-- The newest provider time applied: a stale status-only event is ignored.
ALTER TABLE "OrganizerSubscription" ADD COLUMN "providerStateAt" TIMESTAMP(3);

-- An invoice records one provider document, once.
ALTER TABLE "OrganizerInvoice" ADD COLUMN "provider" "BillingProviderName";
ALTER TABLE "OrganizerInvoice" ADD COLUMN "providerInvoiceRef" TEXT;
CREATE UNIQUE INDEX "OrganizerInvoice_provider_providerInvoiceRef_key"
  ON "OrganizerInvoice"("provider", "providerInvoiceRef");

ALTER TABLE "BillingPayment" ADD COLUMN "purpose" TEXT NOT NULL DEFAULT 'SUBSCRIPTION';
ALTER TABLE "BillingPayment" ADD COLUMN "taxMinor" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "BillingPayment" ADD CONSTRAINT "BillingPayment_purpose_known"
  CHECK ("purpose" IN ('SUBSCRIPTION', 'CREDIT_PACK'));
ALTER TABLE "BillingPayment" ADD CONSTRAINT "BillingPayment_tax_nonnegative" CHECK ("taxMinor" >= 0);

-- Transient processing failures are retried by the worker: how many times, and when it happened.
ALTER TABLE "BillingWebhookEvent" ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "BillingWebhookEvent" ADD COLUMN "occurredAt" TIMESTAMP(3);
