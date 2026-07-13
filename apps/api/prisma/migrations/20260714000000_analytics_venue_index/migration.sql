-- Analytics Platform: venue analytics filters Event by venueId (utilization,
-- occupancy, revenue at a venue). Additive index; no data change.

-- CreateIndex
CREATE INDEX "Event_venueId_idx" ON "Event"("venueId");
