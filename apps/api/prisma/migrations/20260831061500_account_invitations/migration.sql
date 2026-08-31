-- Generalise the team invitation into an ACCOUNT invitation.
--
-- It was introduced for organization teams, keyed on the OrganizationMember it activated.
-- The back-office staff screen turned out to have the same hole for the same reason, and had
-- written it down as a deliberate limitation: it would only search accounts that already
-- existed, because "minting credentials here would mean this screen handing out passwords the
-- account holder never picked". The invitation mechanism is exactly what makes that obsolete.
--
-- So the row becomes about the USER — claiming an account and choosing a password — and the
-- team membership it may also activate becomes optional. The alternative was a second,
-- parallel invitation system for admins, and this codebase has already paid once for one rule
-- living in two places.
--
-- Rewritten in place rather than dropped and recreated: invitations outstanding right now are
-- live credentials somebody is holding, and dropping the table would silently invalidate them.

ALTER TABLE "OrganizationInvitation" RENAME TO "AccountInvitation";

ALTER TABLE "AccountInvitation" RENAME COLUMN "memberId" TO "organizationMemberId";
ALTER TABLE "AccountInvitation" ALTER COLUMN "organizationMemberId" DROP NOT NULL;

-- Backfill from the membership every existing row already points at, so live links survive.
ALTER TABLE "AccountInvitation" ADD COLUMN "userId" TEXT;
UPDATE "AccountInvitation" ai
SET "userId" = m."userId"
FROM "OrganizationMember" m
WHERE ai."organizationMemberId" = m."id";

-- Any row that could not be backfilled points at a membership that no longer exists, so its
-- invitation is meaningless. Removed rather than left holding a NOT NULL that cannot be met.
DELETE FROM "AccountInvitation" WHERE "userId" IS NULL;
ALTER TABLE "AccountInvitation" ALTER COLUMN "userId" SET NOT NULL;

ALTER INDEX "OrganizationInvitation_pkey" RENAME TO "AccountInvitation_pkey";
ALTER INDEX "OrganizationInvitation_tokenHash_key" RENAME TO "AccountInvitation_tokenHash_key";
ALTER INDEX "OrganizationInvitation_memberId_key" RENAME TO "AccountInvitation_organizationMemberId_key";
DROP INDEX IF EXISTS "OrganizationInvitation_memberId_idx";

CREATE UNIQUE INDEX "AccountInvitation_userId_key" ON "AccountInvitation"("userId");
CREATE INDEX "AccountInvitation_userId_idx" ON "AccountInvitation"("userId");

ALTER TABLE "AccountInvitation" RENAME CONSTRAINT "OrganizationInvitation_memberId_fkey" TO "AccountInvitation_organizationMemberId_fkey";
ALTER TABLE "AccountInvitation" RENAME CONSTRAINT "OrganizationInvitation_invitedByUserId_fkey" TO "AccountInvitation_invitedByUserId_fkey";
ALTER TABLE "AccountInvitation" ADD CONSTRAINT "AccountInvitation_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
