-- Let an admin delete a booking-fee band without losing its history.
--
-- Purely additive and nullable. A deleted band is switched off (active = false) and stamped with
-- when and by whom, so the row and its audit entries stay intact. No existing row changes: every
-- band has deletedAt NULL and keeps pricing exactly as before.

ALTER TABLE "FeeRule"
  ADD COLUMN "deletedAt"       TIMESTAMP(3),
  ADD COLUMN "deletedByUserId" TEXT;
