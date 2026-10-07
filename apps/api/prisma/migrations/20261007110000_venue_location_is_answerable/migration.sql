-- A venue may say "I was never asked".
--
-- WHY --------------------------------------------------------------------------------
-- "Venue"."country" defaulted to 'India' and "Venue"."timezone" to 'Asia/Kolkata'. A venue
-- nobody ever asked therefore ANSWERED, and nothing could tell that guess apart from a venue
-- genuinely in India. That is why the venue could not be made the authority for where a space
-- is: its answer was not trustworthy.
--
-- It has already produced two real defects on this track. A Sydney cinema's 00:30 show was
-- stored and reported as 06:00 - the IST offset - because a venue claimed a zone it had never
-- been given, and the same shape of bug was fixed in "Cinema" earlier for the same reason.
-- Both were invisible to every India fixture, where the default and the intended value are
-- the same string.
--
-- WHAT THIS DOES, AND DELIBERATELY DOES NOT ------------------------------------------
-- Structural only. The columns become nullable and lose their defaults, so a value written
-- from here on means somebody supplied it.
--
-- NO EXISTING ROW IS REWRITTEN. Every venue created before this keeps exactly what it has,
-- including the ones that hold 'India' / 'Asia/Kolkata' only because nobody was asked. Those
-- rows are genuinely ambiguous: the data cannot distinguish them, so a migration must not
-- pretend to. `scripts/audit-space-location.mjs` reports them as SUSPECT - a venue holding the
-- old default whose own cinemas say something else - and a backfill is a separate, authorised
-- step once a human has seen that list for each environment.
--
-- Reversible: re-adding the defaults and setting NOT NULL would require a backfill, which is
-- the thing this exists to avoid doing blindly, so the honest reverse is to leave them
-- nullable.

ALTER TABLE "Venue" ALTER COLUMN "country" DROP NOT NULL;
ALTER TABLE "Venue" ALTER COLUMN "country" DROP DEFAULT;

ALTER TABLE "Venue" ALTER COLUMN "timezone" DROP NOT NULL;
ALTER TABLE "Venue" ALTER COLUMN "timezone" DROP DEFAULT;
