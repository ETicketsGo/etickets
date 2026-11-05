-- A COMBINED platform fee: a percentage of the order plus a fixed amount per paid ticket
-- (3% + Rs 5 per ticket). Owner request.
--
-- Purely additive. New enum values on the fee band type and the fee policy kind, and one
-- nullable JSON column on Booking that explains how a COMBINED fee was worked out. No existing
-- row changes: every band keeps its type, every policy its kind, every booking its money.
--
-- The policy terms CHECK constraint is widened in the NEXT migration: Postgres does not allow a
-- new enum value to be used in the same transaction that adds it.

ALTER TYPE "FeeRuleType" ADD VALUE IF NOT EXISTS 'COMBINED';
ALTER TYPE "PlatformFeePolicyKind" ADD VALUE IF NOT EXISTS 'COMBINED';

ALTER TABLE "Booking" ADD COLUMN "platformFeeBreakdown" JSONB;
