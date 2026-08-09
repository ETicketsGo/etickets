-- Screen operational status, so a single screen can be taken out of service without
-- affecting the rest of the cinema.
--
-- Purely additive and safe on a live table: the column is NOT NULL with a DEFAULT, so
-- PostgreSQL 11+ fills it in via the catalog rather than rewriting every row, and every
-- existing screen becomes ACTIVE — which is what it was implicitly before this existed.
--
-- Nothing about existing shows changes. Taking a screen out of service deliberately does
-- NOT cancel what is already scheduled on it: cancelling a show somebody has paid for is an
-- explicit, audited, per-show act and must never be a side effect of a status change.
CREATE TYPE "ScreenStatus" AS ENUM ('ACTIVE', 'MAINTENANCE', 'INACTIVE');

ALTER TABLE "Screen" ADD COLUMN "status" "ScreenStatus" NOT NULL DEFAULT 'ACTIVE';
