-- A mapped GA/VIP product prices one physical SeatZone. Capacity remains authoritative in
-- ShowZone; this foreign key is only the durable link from the ticket offered to that zone.
ALTER TABLE "TicketType" ADD COLUMN "seatZoneId" TEXT;

CREATE INDEX "TicketType_seatZoneId_idx" ON "TicketType"("seatZoneId");

ALTER TABLE "TicketType"
ADD CONSTRAINT "TicketType_seatZoneId_fkey"
FOREIGN KEY ("seatZoneId") REFERENCES "SeatZone"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
