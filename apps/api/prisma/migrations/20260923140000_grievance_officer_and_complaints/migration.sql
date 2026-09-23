-- Who answers a complaint about an organizer, and which organizer a complaint is about.
--
-- ── WHY THESE TWO CHANGES ARE ONE MIGRATION ───────────────────────────────────────────
-- They are the two halves of one obligation. A marketplace that sells other people's tickets has
-- to be able to say who handles a grievance (the officer, on the organization) and to answer how
-- many are open against a given seller (the attribution, on the feedback row). India's e-commerce
-- rules require both in as many words, and every other market this platform sells in expects the
-- substance of them. One without the other is a form nobody reads or a count nobody can act on.

-- The named person who answers a complaint. All nullable: organizers registered before this
-- existed have none on file, and the readiness list asks them for it rather than inventing one.
ALTER TABLE "Organization" ADD COLUMN "grievanceOfficerName" TEXT;
ALTER TABLE "Organization" ADD COLUMN "grievanceOfficerEmail" TEXT;
ALTER TABLE "Organization" ADD COLUMN "grievanceOfficerPhone" TEXT;

-- A complaint is its own kind, not a CONTACT message, because it has to be countable per seller.
-- Added before the columns that carry it so a deploy that stops here still has a valid enum.
ALTER TYPE "FeedbackKind" ADD VALUE IF NOT EXISTS 'COMPLAINT';

-- Which organizer, and which booking. Deliberately NO foreign keys, exactly as
-- "AuditLog"."organizationId" has none: a complaint has to outlive the booking, the event and the
-- organization it was about, which are the cases where the record matters most. A cascade would
-- delete the evidence along with its subject, and a restrict would make a complaint the reason an
-- admin cannot remove a test organization.
ALTER TABLE "Feedback" ADD COLUMN "organizationId" TEXT;
ALTER TABLE "Feedback" ADD COLUMN "bookingId" TEXT;

-- The index the count reads: "open complaints against this organizer".
CREATE INDEX "Feedback_organizationId_idx" ON "Feedback"("organizationId");
