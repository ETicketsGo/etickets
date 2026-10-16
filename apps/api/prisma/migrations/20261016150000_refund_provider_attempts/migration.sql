-- Refund retries ask the provider what happened before anything is sent again.
--
-- The payment orchestrator retried a timed-out refund call up to twice. A call that reached
-- Razorpay or Stripe and only lost its answer was then sent again, which can refund a customer
-- twice. Refund calls are now sent once, with a stable idempotency key, and a lost answer is
-- settled by asking the provider for the payment's refunds. What cannot be settled that way is
-- held for a person.
--
-- Purely additive: four columns on "Refund" (nullable, or with a default) and one new table.
-- An older API ignores them and keeps working against a migrated database.

-- AlterTable
ALTER TABLE "Refund" ADD COLUMN     "manualReviewAt" TIMESTAMP(3),
ADD COLUMN     "manualReviewReason" TEXT,
ADD COLUMN     "providerCallCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "providerIdempotencyKey" TEXT;

-- CreateTable
CREATE TABLE "RefundProviderAttempt" (
    "id" TEXT NOT NULL,
    "refundId" TEXT NOT NULL,
    "attemptNo" INTEGER NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "outcome" TEXT NOT NULL DEFAULT 'SENT',
    "providerRefundRef" TEXT,
    "detail" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "RefundProviderAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RefundProviderAttempt_idempotencyKey_idx" ON "RefundProviderAttempt"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "RefundProviderAttempt_refundId_attemptNo_key" ON "RefundProviderAttempt"("refundId", "attemptNo");

-- CreateIndex
CREATE UNIQUE INDEX "Refund_providerIdempotencyKey_key" ON "Refund"("providerIdempotencyKey");

-- AddForeignKey
ALTER TABLE "RefundProviderAttempt" ADD CONSTRAINT "RefundProviderAttempt_refundId_fkey" FOREIGN KEY ("refundId") REFERENCES "Refund"("id") ON DELETE CASCADE ON UPDATE CASCADE;
