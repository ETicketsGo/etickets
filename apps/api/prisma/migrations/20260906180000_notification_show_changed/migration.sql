-- SHOW_CHANGED: a show somebody already holds a ticket for has moved.
--
-- Additive enum value. Rescheduling a show previously updated the session, wrote an
-- audit entry, and notified nobody -- a customer who had paid found out by arriving
-- at the old time.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'SHOW_CHANGED';
