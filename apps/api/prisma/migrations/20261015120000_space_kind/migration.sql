-- What kind of place a space is (W2). Additive and nullable, with no backfill: an existing
-- space has never been asked, and a guessed kind would offer it the wrong layout templates.
-- Readers treat a null kind on a cinema's screen as CINEMA_SCREEN, and any other null as
-- "not said yet", which keeps every template on offer exactly as before.
CREATE TYPE "SpaceKind" AS ENUM ('CINEMA_SCREEN', 'SEATED_HALL', 'ARENA', 'STANDING');
ALTER TABLE "Screen" ADD COLUMN "kind" "SpaceKind";
