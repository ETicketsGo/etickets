-- Platform fee overrides and waivers (organizer- and event-level), with append-only history.
--
-- Additive and backward compatible:
--   * three new enums and two new tables; nothing existing is altered except "Booking";
--   * five NULLABLE columns on "Booking", no default and no backfill. NULL means "priced by the
--     ordinary fee schedule", which is true of every existing booking. Existing inserts and
--     updates that do not name them keep working, and no historical order is recalculated;
--   * the money columns on "Booking" keep meaning the CHARGED amounts, so receipts, refunds,
--     settlement, payouts and finance read exactly what they read before.
-- Rollback: the previous API ignores the new tables and columns; dropping is never required.
--
-- Conflicting policies (two live policies for the same event or organization over the same
-- time) are refused by the API under a transaction-scoped advisory lock, not by a constraint
-- here: an exclusion constraint would need btree_gist and cannot be described in schema.prisma
-- without the migration-drift check failing. The CHECK constraints at the end are not described
-- in schema.prisma either, but Prisma does not compare CHECK constraints, so they do not drift.

-- CreateEnum
CREATE TYPE "PlatformFeePolicyScope" AS ENUM ('EVENT', 'ORGANIZATION');

-- CreateEnum
CREATE TYPE "PlatformFeePolicyKind" AS ENUM ('WAIVE', 'FIXED', 'PERCENT');

-- CreateEnum
CREATE TYPE "PlatformFeePolicyStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'EXPIRED', 'EXHAUSTED');

-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "baseBookingFeeMinor" INTEGER,
ADD COLUMN     "feePolicyId" TEXT,
ADD COLUMN     "feePolicyKind" "PlatformFeePolicyKind",
ADD COLUMN     "feePolicyVersion" INTEGER,
ADD COLUMN     "feeWaivedMinor" INTEGER;

-- CreateTable
CREATE TABLE "PlatformFeePolicy" (
    "id" TEXT NOT NULL,
    "scope" "PlatformFeePolicyScope" NOT NULL,
    "eventId" TEXT,
    "organizationId" TEXT NOT NULL,
    "kind" "PlatformFeePolicyKind" NOT NULL,
    "feeMinor" INTEGER,
    "percentBps" INTEGER,
    "minFeeMinor" INTEGER,
    "maxFeeMinor" INTEGER,
    "currency" TEXT,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3),
    "maxOrders" INTEGER,
    "usedOrders" INTEGER NOT NULL DEFAULT 0,
    "status" "PlatformFeePolicyStatus" NOT NULL DEFAULT 'ACTIVE',
    "reason" TEXT NOT NULL,
    "approvalReference" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "deactivatedAt" TIMESTAMP(3),
    "deactivatedByUserId" TEXT,
    "deactivationReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformFeePolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformFeePolicyEvent" (
    "id" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actorUserId" TEXT,
    "reason" TEXT,
    "snapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformFeePolicyEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PlatformFeePolicy_scope_eventId_status_idx" ON "PlatformFeePolicy"("scope", "eventId", "status");

-- CreateIndex
CREATE INDEX "PlatformFeePolicy_scope_organizationId_status_idx" ON "PlatformFeePolicy"("scope", "organizationId", "status");

-- CreateIndex
CREATE INDEX "PlatformFeePolicy_status_createdAt_idx" ON "PlatformFeePolicy"("status", "createdAt");

-- CreateIndex
CREATE INDEX "PlatformFeePolicyEvent_policyId_createdAt_idx" ON "PlatformFeePolicyEvent"("policyId", "createdAt");

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_feePolicyId_fkey" FOREIGN KEY ("feePolicyId") REFERENCES "PlatformFeePolicy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlatformFeePolicyEvent" ADD CONSTRAINT "PlatformFeePolicyEvent_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "PlatformFeePolicy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The redemption counter can never go below zero or past its limit, whatever a caller does.
ALTER TABLE "PlatformFeePolicy" ADD CONSTRAINT "PlatformFeePolicy_usedOrders_check"
  CHECK ("usedOrders" >= 0 AND ("maxOrders" IS NULL OR "usedOrders" <= "maxOrders"));
ALTER TABLE "PlatformFeePolicy" ADD CONSTRAINT "PlatformFeePolicy_maxOrders_check"
  CHECK ("maxOrders" IS NULL OR "maxOrders" > 0);
-- An EVENT policy names its event; an ORGANIZATION policy does not.
ALTER TABLE "PlatformFeePolicy" ADD CONSTRAINT "PlatformFeePolicy_scope_check"
  CHECK (("scope" = 'EVENT' AND "eventId" IS NOT NULL) OR ("scope" = 'ORGANIZATION' AND "eventId" IS NULL));
-- Each kind carries exactly the amount it needs.
ALTER TABLE "PlatformFeePolicy" ADD CONSTRAINT "PlatformFeePolicy_terms_check"
  CHECK (
    ("kind" = 'WAIVE' AND "feeMinor" IS NULL AND "percentBps" IS NULL)
    OR ("kind" = 'FIXED' AND "feeMinor" IS NOT NULL AND "feeMinor" >= 0 AND "percentBps" IS NULL AND "currency" IS NOT NULL)
    OR ("kind" = 'PERCENT' AND "percentBps" IS NOT NULL AND "percentBps" BETWEEN 0 AND 10000 AND "feeMinor" IS NULL)
  );
ALTER TABLE "PlatformFeePolicy" ADD CONSTRAINT "PlatformFeePolicy_window_check"
  CHECK ("endsAt" IS NULL OR "endsAt" > "startsAt");
-- A waived amount is never negative.
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_feeWaivedMinor_check"
  CHECK ("feeWaivedMinor" IS NULL OR "feeWaivedMinor" >= 0);
