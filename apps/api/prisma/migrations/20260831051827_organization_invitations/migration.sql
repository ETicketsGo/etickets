-- Invitations that can actually be accepted.
--
-- Every OrganizationMember created by the old invite path sits at status INVITED, and
-- `assertMember` requires ACTIVE — so they are all locked out of the organization they were
-- added to. There is deliberately NO BACKFILL flipping them to ACTIVE.
--
-- Flipping them would grant live access to people who never accepted anything, on the say-so
-- of a row that was written months ago. And it would not even work for most of them: an
-- invitee who had no prior account got a User row with a random password nobody knows, so
-- ACTIVE without a way to sign in changes nothing. The owner re-sends an invite link per
-- person instead, which is visible, deliberate, and leaves an audit trail.

-- CreateTable
CREATE TABLE "OrganizationInvitation" (
    "id" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "invitedByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizationInvitation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationInvitation_memberId_key" ON "OrganizationInvitation"("memberId");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationInvitation_tokenHash_key" ON "OrganizationInvitation"("tokenHash");

-- CreateIndex
CREATE INDEX "OrganizationInvitation_memberId_idx" ON "OrganizationInvitation"("memberId");

-- AddForeignKey
ALTER TABLE "OrganizationInvitation" ADD CONSTRAINT "OrganizationInvitation_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "OrganizationMember"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationInvitation" ADD CONSTRAINT "OrganizationInvitation_invitedByUserId_fkey" FOREIGN KEY ("invitedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
