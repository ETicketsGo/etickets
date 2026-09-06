-- What each stored tax line was levied on, and whether it was inside the price.
--
-- Nullable with no backfill. A value invented for a historic row would be a guess printed on
-- a financial document; `priceBreakdown` instead derives the answer from arithmetic that is
-- already on the booking (subtotal, discount, fee, total), which is a fact rather than an
-- assumption.
ALTER TABLE "BookingTaxLine" ADD COLUMN "basis" TEXT;
ALTER TABLE "BookingTaxLine" ADD COLUMN "inclusive" BOOLEAN;
