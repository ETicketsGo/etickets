-- How an event is attended. Additive: every existing event defaults to IN_PERSON.
CREATE TYPE "AttendanceMode" AS ENUM ('IN_PERSON', 'ONLINE', 'HYBRID');
ALTER TABLE "Event" ADD COLUMN "attendanceMode" "AttendanceMode" NOT NULL DEFAULT 'IN_PERSON';

-- Events organizers already made "online" the only way they could: a venue whose city is
-- "Online". They become ONLINE so city discovery finds them; the venue is left as it is.
UPDATE "Event" e
SET "attendanceMode" = 'ONLINE'
FROM "Venue" v
WHERE v.id = e."venueId" AND lower(trim(v.city)) = 'online';
