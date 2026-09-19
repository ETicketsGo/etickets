-- A buyer with no account could pay for a ticket and then had no way to reach it.
--
-- Guest checkout minted a booking, took the money and issued the tickets, and everything that
-- could read them back needed a signed-in user. The confirmation email carried no link, and the
-- one thing a guest can always produce -- their reference and the address they typed -- opened
-- nothing. This table is the credential that closes that: an emailed link, honoured until it
-- expires or a fresher one supersedes it.
--
-- Only the SHA-256 of the token is stored, for the same reason "PasswordResetToken" stores only
-- a hash: a dump of this table must not open anybody's booking.
--
-- Purely additive. No existing table gains a column, loses one, or gains a requirement, so an
-- older API keeps working against a migrated database.

-- The recovery email is its own notification type, so it can be rate-limited and deduped
-- apart from the confirmation that carries somebody's tickets.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'GUEST_BOOKING_ACCESS';

-- CreateTable
CREATE TABLE "GuestBookingAccess" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "openCount" INTEGER NOT NULL DEFAULT 0,
    "lastOpenedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GuestBookingAccess_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GuestBookingAccess_tokenHash_key" ON "GuestBookingAccess"("tokenHash");

-- CreateIndex
CREATE INDEX "GuestBookingAccess_bookingId_idx" ON "GuestBookingAccess"("bookingId");

-- CreateIndex
CREATE INDEX "GuestBookingAccess_expiresAt_idx" ON "GuestBookingAccess"("expiresAt");

-- AddForeignKey
ALTER TABLE "GuestBookingAccess" ADD CONSTRAINT "GuestBookingAccess_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;
