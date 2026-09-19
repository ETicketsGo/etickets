-- Guest self-service: the buyer with no account can now get an invoice, ask for a refund, and
-- attach the booking to an account.
--
-- Only one thing in the database has to change for that: a notification type. The receipt is
-- already issued for every confirmed booking, the Refund table already records a request with no
-- `requestedByUserId`, and a claim is a write to `Booking.userId`, which has always been nullable
-- precisely because guest bookings have no owner.
--
-- Purely additive. No table gains a column, loses one, or gains a requirement, so an older API
-- keeps working against a migrated database — and a newer API against an unmigrated one fails
-- only on the one new value, rather than anywhere near the money.

-- A refund has been ASKED for. REFUND_COMPLETED cannot do this job: it is sent after an
-- organizer approves, which may be days later, and never at all for a request that is refused.
-- The point of telling the buyer at REQUEST time is that a guest access link is forwardable, so
-- the person asking may not be the person whose money it is.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'REFUND_REQUESTED';
