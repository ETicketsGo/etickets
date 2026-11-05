-- The organizer recent-bookings list reads newest first per organization.
CREATE INDEX "Booking_organizationId_createdAt_idx" ON "Booking"("organizationId", "createdAt");
