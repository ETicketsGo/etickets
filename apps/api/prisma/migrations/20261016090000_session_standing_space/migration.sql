-- The standing (general-admission) space a session is held in, so the space's capacity can cap
-- the tickets on sale. Additive and nullable: every existing session keeps NULL (no cap), and an
-- older API instance that does not know the column keeps working during a rolling deploy.
ALTER TABLE "EventSession" ADD COLUMN "standingSpaceId" TEXT;

CREATE INDEX "EventSession_standingSpaceId_idx" ON "EventSession"("standingSpaceId");

ALTER TABLE "EventSession" ADD CONSTRAINT "EventSession_standingSpaceId_fkey" FOREIGN KEY ("standingSpaceId") REFERENCES "Screen"("id") ON DELETE SET NULL ON UPDATE CASCADE;
