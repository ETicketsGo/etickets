-- Resuming a paused event can no longer skip review.
--
-- `needsReviewOnResume` remembers that reviewed details (title, description, category, venue,
-- fees, refund terms, free/paid) were changed while the event was paused, so resuming sends it
-- to the review queue unless the organizer is trusted to auto-publish. `pausedByAdminAt` marks
-- a pause made by the platform team, which only an admin may lift.
--
-- Existing rows take the defaults: no pending review and no admin pause. Nothing already paused
-- is retroactively held, because nothing recorded who paused it or what changed before now.

-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "needsReviewOnResume" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "pausedByAdminAt" TIMESTAMP(3);
