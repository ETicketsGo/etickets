-- Attendee identity layer (ADR-031).

-- 1. New enums.
CREATE TYPE "AttendeeAssignmentStatus" AS ENUM ('UNASSIGNED', 'ASSIGNED', 'INVITED', 'ACCEPTED', 'DECLINED');
CREATE TYPE "TicketInviteKind" AS ENUM ('INVITE', 'TRANSFER');
CREATE TYPE "TicketInviteStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'REVOKED', 'EXPIRED');

-- 2. Additive NotificationType values.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'ATTENDEE_INVITED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'ATTENDEE_ACCEPTED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'ATTENDEE_DECLINED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'TICKET_TRANSFERRED';

-- 3. Attendee identity columns on Ticket (all additive / nullable).
ALTER TABLE "Ticket"
  ADD COLUMN "assignmentStatus" "AttendeeAssignmentStatus" NOT NULL DEFAULT 'UNASSIGNED',
  ADD COLUMN "attendeeUserId" TEXT,
  ADD COLUMN "attendeePhone" TEXT,
  ADD COLUMN "attendeeCountry" TEXT,
  ADD COLUMN "attendeeCompany" TEXT,
  ADD COLUMN "attendeeDesignation" TEXT,
  ADD COLUMN "attendeeStudentId" TEXT,
  ADD COLUMN "attendeeMemberId" TEXT,
  ADD COLUMN "attendeeCustomFields" JSONB;

CREATE INDEX "Ticket_attendeeUserId_idx" ON "Ticket"("attendeeUserId");
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_attendeeUserId_fkey"
  FOREIGN KEY ("attendeeUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 4. Invitation / transfer ledger.
CREATE TABLE "TicketInvite" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "kind" "TicketInviteKind" NOT NULL DEFAULT 'INVITE',
    "status" "TicketInviteStatus" NOT NULL DEFAULT 'PENDING',
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdByUserId" TEXT,
    "acceptedByUserId" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TicketInvite_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TicketInvite_tokenHash_key" ON "TicketInvite"("tokenHash");
CREATE INDEX "TicketInvite_ticketId_idx" ON "TicketInvite"("ticketId");
CREATE INDEX "TicketInvite_status_idx" ON "TicketInvite"("status");
CREATE INDEX "TicketInvite_organizationId_idx" ON "TicketInvite"("organizationId");
ALTER TABLE "TicketInvite" ADD CONSTRAINT "TicketInvite_ticketId_fkey"
  FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 5. Backfill: existing tickets bought by a signed-in owner are treated as
--    ASSIGNED to that owner (they already carry the buyer's name/email), so the
--    owner keeps seeing them and the identity layer starts from a truthful state.
UPDATE "Ticket" t
SET "assignmentStatus" = 'ASSIGNED', "attendeeUserId" = b."userId"
FROM "Booking" b
WHERE t."bookingId" = b."id" AND b."userId" IS NOT NULL;
