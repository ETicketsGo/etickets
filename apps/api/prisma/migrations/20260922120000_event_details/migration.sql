-- Event details buyers ask for before they pay: an age limit, the organizer's terms and
-- conditions, and who is performing.
--
-- Purely additive and nullable. Existing events show nothing new until an organizer fills these
-- in, and an older API ignores the columns. Duration is deliberately NOT stored: each show
-- already has a start and an end, and a separate duration would be a second answer that can
-- disagree with them.

ALTER TABLE "Event"
  ADD COLUMN "ageLimit"           INTEGER,
  ADD COLUMN "termsAndConditions" TEXT,
  ADD COLUMN "artists"            JSONB;
