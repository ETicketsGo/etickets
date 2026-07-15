-- Secure Experience Sharing platform (ADR-032). Extends the TicketInvite ledger
-- rather than adding a duplicate share table.

-- 1. New enums.
CREATE TYPE "SharePermission" AS ENUM ('VIEW', 'GUEST', 'TRANSFER');
CREATE TYPE "ResourceType" AS ENUM ('TICKET', 'MEMBERSHIP', 'PARKING_PASS', 'FOOD_VOUCHER', 'VIP_PASS');

-- 2. Additive NotificationType values.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'SHARE_CREATED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'SHARE_VIEWED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'SHARE_REVOKED';

-- 3. Share columns on the invite/share ledger. Defaults backfill existing rows
--    (existing invites become TRANSFER/TICKET). email becomes optional because a
--    view/guest link need not target a specific recipient.
ALTER TABLE "TicketInvite"
  ADD COLUMN "permission" "SharePermission" NOT NULL DEFAULT 'TRANSFER',
  ADD COLUMN "resourceType" "ResourceType" NOT NULL DEFAULT 'TICKET',
  ADD COLUMN "maxOpens" INTEGER,
  ADD COLUMN "openCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastOpenedAt" TIMESTAMP(3),
  ADD COLUMN "lastOpenedByUserId" TEXT,
  ADD COLUMN "label" TEXT;

ALTER TABLE "TicketInvite" ALTER COLUMN "email" DROP NOT NULL;
