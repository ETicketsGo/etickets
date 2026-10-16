-- Cash handed back at the counter after a show was cancelled.
--
-- Cash never passes through the platform, so it cannot be refunded online and a `Refund` row
-- would be a false record of money moving through a provider. Cancelling the show voids the
-- cash booking's tickets; these two columns record, offline, when the money went back across
-- the counter and who handed it. Additive and nullable: every existing row reads "not returned".
ALTER TABLE "Booking"
  ADD COLUMN "cashReturnedAt" TIMESTAMP(3),
  ADD COLUMN "cashReturnedByUserId" TEXT;

ALTER TABLE "Booking" ADD CONSTRAINT "Booking_cashReturnedByUserId_fkey"
  FOREIGN KEY ("cashReturnedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
