-- AlterTable
ALTER TABLE "Payout" ADD COLUMN     "allocatedFrom" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "PayoutAllocation" (
    "id" TEXT NOT NULL,
    "payoutId" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "allocatedNetMinor" INTEGER NOT NULL,
    "subtotalMinor" INTEGER NOT NULL,
    "discountMinor" INTEGER NOT NULL,
    "organizerFeeMinor" INTEGER NOT NULL,
    "refundShareMinor" INTEGER NOT NULL,
    "bookingFeeMinor" INTEGER NOT NULL,
    "paymentFeeMinor" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayoutAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PayoutAllocation_payoutId_idx" ON "PayoutAllocation"("payoutId");

-- CreateIndex
CREATE INDEX "PayoutAllocation_bookingId_idx" ON "PayoutAllocation"("bookingId");

-- CreateIndex
CREATE INDEX "PayoutAllocation_eventId_idx" ON "PayoutAllocation"("eventId");

-- CreateIndex
CREATE UNIQUE INDEX "PayoutAllocation_payoutId_bookingId_key" ON "PayoutAllocation"("payoutId", "bookingId");

-- AddForeignKey
ALTER TABLE "PayoutAllocation" ADD CONSTRAINT "PayoutAllocation_payoutId_fkey" FOREIGN KEY ("payoutId") REFERENCES "Payout"("id") ON DELETE CASCADE ON UPDATE CASCADE;
