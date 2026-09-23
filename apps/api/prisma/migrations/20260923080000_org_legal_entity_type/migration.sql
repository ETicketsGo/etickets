-- What an organizer registered AS, which every organizer has, as opposed to a tax
-- registration, which only some of them have. Approval asks for this instead.
ALTER TABLE "Organization" ADD COLUMN "legalEntityType" TEXT;
