-- A FIXED_PER_TICKET platform fee: a fixed amount for each paid ticket (Rs 5 per ticket is
-- Rs 15 for three tickets). Owner decision 2026-10-29.
--
-- Purely additive. One new enum value on the fee band type and one on the fee policy kind. No
-- existing row changes: every band keeps its type (FLAT still charges once per order), every
-- policy its kind, every booking its money. The optional minimum and maximum fee reuse the
-- existing nullable "minFeeMinor" / "maxFeeMinor" columns, and the per-ticket snapshot reuses
-- "Booking"."platformFeeBreakdown", so no column is added.
--
-- The policy terms CHECK constraint is widened in the NEXT migration: Postgres does not allow a
-- new enum value to be used in the same transaction that adds it.

ALTER TYPE "FeeRuleType" ADD VALUE IF NOT EXISTS 'FIXED_PER_TICKET';
ALTER TYPE "PlatformFeePolicyKind" ADD VALUE IF NOT EXISTS 'FIXED_PER_TICKET';
