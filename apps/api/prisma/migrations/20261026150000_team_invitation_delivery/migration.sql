-- Team invitations are delivered to the invitee by email only, and an invitation can be revoked
-- (owner decision, 2026-10-26: the inviter never holds a usable acceptance link).
--
-- Additive and backward compatible:
--   * one new enum value, which no existing row holds and the deployed API never writes;
--   * one NULLABLE column on "AccountInvitation" with no default and no backfill. Existing
--     inserts and updates that do not name it keep working unchanged.
-- Tokens were already stored hashed (SHA-256 in "tokenHash"), so no token data moves.
-- Rollback: the previous API ignores both; dropping is never required to roll back.

ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'TEAM_INVITATION';

ALTER TABLE "AccountInvitation" ADD COLUMN "revokedAt" TIMESTAMP(3);
