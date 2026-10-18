-- Messages from the public Contact and Help forms now reach the support mailbox by email.
--
-- A form message was stored as a Feedback row and nothing else: no email to the support
-- mailbox and no acknowledgement to the sender, so a message could sit unread until somebody
-- happened to open the admin console.
--
-- Purely additive: two notification types. An older API never sends them, so it keeps
-- working against a migrated database.

ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'SUPPORT_REQUEST_RECEIVED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'SUPPORT_REQUEST_ACKNOWLEDGED';
