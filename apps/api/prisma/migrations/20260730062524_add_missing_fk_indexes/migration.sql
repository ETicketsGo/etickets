-- CreateIndex
CREATE INDEX "AuditLog_actorUserId_idx" ON "AuditLog"("actorUserId");

-- CreateIndex
CREATE INDEX "Booking_couponId_idx" ON "Booking"("couponId");

-- CreateIndex
CREATE INDEX "BookingItem_ticketTypeId_idx" ON "BookingItem"("ticketTypeId");

-- CreateIndex
CREATE INDEX "BundleItem_ticketTypeId_idx" ON "BundleItem"("ticketTypeId");

-- CreateIndex
CREATE INDEX "BundleItem_addOnId_idx" ON "BundleItem"("addOnId");

-- CreateIndex
CREATE INDEX "CheckIn_byUserId_idx" ON "CheckIn"("byUserId");

-- CreateIndex
CREATE INDEX "Cinema_venueId_idx" ON "Cinema"("venueId");

-- CreateIndex
CREATE INDEX "Feedback_userId_idx" ON "Feedback"("userId");

-- CreateIndex
CREATE INDEX "Review_userId_idx" ON "Review"("userId");

-- CreateIndex
CREATE INDEX "Seat_seatCategoryId_idx" ON "Seat"("seatCategoryId");

-- CreateIndex
CREATE INDEX "Settlement_accountId_idx" ON "Settlement"("accountId");

-- CreateIndex
CREATE INDEX "ShowSeat_seatId_idx" ON "ShowSeat"("seatId");

-- CreateIndex
CREATE INDEX "Ticket_ticketTypeId_idx" ON "Ticket"("ticketTypeId");
