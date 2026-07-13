-- CreateIndex
CREATE INDEX "Booking_userId_idx" ON "Booking"("userId");

-- CreateIndex
CREATE INDEX "Booking_eventSessionId_status_idx" ON "Booking"("eventSessionId", "status");

-- CreateIndex
CREATE INDEX "Booking_confirmedAt_idx" ON "Booking"("confirmedAt");

-- CreateIndex
CREATE INDEX "Event_status_experienceType_publishedAt_idx" ON "Event"("status", "experienceType", "publishedAt");

-- CreateIndex
CREATE INDEX "Movie_status_releaseDate_idx" ON "Movie"("status", "releaseDate");

-- CreateIndex
CREATE INDEX "Refund_organizationId_idx" ON "Refund"("organizationId");
