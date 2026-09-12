-- A payment is in the currency of the booking it pays for.
--
-- The booking create path wrote Payment rows without a currency, so every one took the column
-- default 'INR' — on QA, twelve payments for US-dollar bookings were recorded in rupees. The code
-- now writes the booking's currency; this corrects the rows written before it.
--
-- Data only: no column changes. Rows already in the right currency are not touched, so running it
-- again changes nothing.
UPDATE "Payment" AS p
SET "currency" = b."currency",
    "updatedAt" = NOW()
FROM "Booking" AS b
WHERE b."id" = p."bookingId"
  AND p."currency" IS DISTINCT FROM b."currency";
