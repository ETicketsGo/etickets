-- The state the buyer said they were in, as used to decide place of supply.
--
-- Nullable and with no default: null means "the buyer did not say", which is a defined
-- answer (the sale was treated as intra-state), not a missing one. Backfilling it would
-- assert something about past bookings that nobody asked those buyers.
ALTER TABLE "Booking" ADD COLUMN "customerRegion" TEXT;
