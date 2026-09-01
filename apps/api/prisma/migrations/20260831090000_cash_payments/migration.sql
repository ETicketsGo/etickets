-- Cash paid at the venue.
--
-- Asked for by an operator from a village where the cinema takes cash only: "this product
-- will be really helpful for them who cannot build and pay for software vendors". Those
-- venues are not a rounding error, and a ticketing platform that insists on a card reader
-- is unusable to them.
--
-- The important consequence is financial, not technical. A cash booking's money never
-- passes through the platform, so it must never appear in a settlement as an amount owed to
-- the organizer — there is no bank statement it could be reconciled against. That falls out
-- of the design rather than needing to be enforced: like a free booking, a cash booking
-- creates NO Payment row, and settlement reads Payment rows.

CREATE TYPE "BookingPaymentMethod" AS ENUM ('ONLINE', 'CASH');

-- Existing bookings all went through a provider. ONLINE is the truthful backfill, and the
-- default keeps every code path that does not mention cash behaving exactly as before.
ALTER TABLE "Booking"
  ADD COLUMN "paymentMethod" "BookingPaymentMethod" NOT NULL DEFAULT 'ONLINE',
  ADD COLUMN "cashCollectedAt" TIMESTAMP(3),
  ADD COLUMN "cashCollectedByUserId" TEXT;

ALTER TABLE "Booking" ADD CONSTRAINT "Booking_cashCollectedByUserId_fkey"
  FOREIGN KEY ("cashCollectedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Off for everybody. Taking money the platform will never see changes who is responsible
-- for collecting it and what a settlement can promise, so it is opted into, never inherited.
ALTER TABLE "Organization" ADD COLUMN "cashPaymentsEnabled" BOOLEAN NOT NULL DEFAULT false;

-- The organizer's unpaid-cash list is the one query this feature adds to the hot path.
CREATE INDEX "Booking_paymentMethod_status_idx" ON "Booking"("paymentMethod", "status");
