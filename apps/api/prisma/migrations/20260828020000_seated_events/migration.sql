-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "seatBased" BOOLEAN NOT NULL DEFAULT false;

-- Backfill: every booking that already holds seats.
--
-- Until now "seat-based" meant "the event is a MOVIE", so that is exactly the set to mark.
-- Done by joining through the session rather than by looking for Ticket rows with a seatId,
-- because a booking that is still PENDING_PAYMENT has held seats and no tickets yet, and
-- leaving those unmarked would change how they settle when their payment lands.
UPDATE "Booking" b
SET "seatBased" = true
FROM "Event" e
WHERE b."eventId" = e.id
  AND e."experienceType" = 'MOVIE';
