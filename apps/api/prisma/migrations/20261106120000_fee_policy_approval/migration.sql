-- Maker-checker for platform fee policies (event and organizer fee overrides). AR-10.
--
-- Additive only: three enum values and nullable columns (one boolean with a default).
-- Existing rows are untouched: a policy that is ACTIVE today stays ACTIVE and keeps pricing.
-- New enum values are compared as ::text inside the trigger function, so nothing in this
-- migration USES a value it adds (PostgreSQL refuses that inside one transaction).
--
-- Rolling back the application code: the previous release inserts policies as ACTIVE with no
-- approver, which the guard below refuses. Creating a policy then fails closed (nothing is
-- priced by it); pricing, holds and refunds are unaffected.

-- AlterEnum
ALTER TYPE "PlatformFeePolicyStatus" ADD VALUE 'PENDING_APPROVAL';
ALTER TYPE "PlatformFeePolicyStatus" ADD VALUE 'REJECTED';
ALTER TYPE "PlatformFeePolicyStatus" ADD VALUE 'WITHDRAWN';

-- AlterTable
ALTER TABLE "PlatformFeePolicy" ADD COLUMN     "approvalNote" TEXT,
ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "approvedByUserId" TEXT,
ADD COLUMN     "deactivationRequestReason" TEXT,
ADD COLUMN     "deactivationRequestedAt" TIMESTAMP(3),
ADD COLUMN     "deactivationRequestedByUserId" TEXT,
ADD COLUMN     "emergencyDeactivation" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "rejectedAt" TIMESTAMP(3),
ADD COLUMN     "rejectedByUserId" TEXT,
ADD COLUMN     "rejectionNote" TEXT;

-- What a policy charges, and for whom, never changes after it is created. A policy only
-- starts pricing when somebody other than its creator approved it, and only stops through an
-- approved request or the recorded emergency path. Final states stay final.
CREATE FUNCTION "platform_fee_policy_guard"() RETURNS trigger AS $$
DECLARE
  old_status text;
  new_status text := NEW."status"::text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF new_status <> 'PENDING_APPROVAL'
       AND (NEW."approvedByUserId" IS NULL OR NEW."approvedByUserId" = NEW."createdByUserId") THEN
      RAISE EXCEPTION 'PlatformFeePolicy must be created PENDING_APPROVAL (got %)', new_status
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;

  old_status := OLD."status"::text;

  IF NEW."scope" IS DISTINCT FROM OLD."scope"
     OR NEW."eventId" IS DISTINCT FROM OLD."eventId"
     OR NEW."organizationId" IS DISTINCT FROM OLD."organizationId"
     OR NEW."kind" IS DISTINCT FROM OLD."kind"
     OR NEW."feeMinor" IS DISTINCT FROM OLD."feeMinor"
     OR NEW."percentBps" IS DISTINCT FROM OLD."percentBps"
     OR NEW."minFeeMinor" IS DISTINCT FROM OLD."minFeeMinor"
     OR NEW."maxFeeMinor" IS DISTINCT FROM OLD."maxFeeMinor"
     OR NEW."currency" IS DISTINCT FROM OLD."currency"
     OR NEW."endsAt" IS DISTINCT FROM OLD."endsAt"
     OR NEW."maxOrders" IS DISTINCT FROM OLD."maxOrders"
     OR NEW."createdByUserId" IS DISTINCT FROM OLD."createdByUserId"
     OR NEW."reason" IS DISTINCT FROM OLD."reason" THEN
    RAISE EXCEPTION 'PlatformFeePolicy % terms cannot change', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."startsAt" IS DISTINCT FROM OLD."startsAt" AND old_status <> 'PENDING_APPROVAL' THEN
    RAISE EXCEPTION 'PlatformFeePolicy % start can only move while it waits for approval', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."approvedByUserId" IS NOT NULL
     AND NEW."approvedByUserId" IS DISTINCT FROM OLD."approvedByUserId" THEN
    RAISE EXCEPTION 'PlatformFeePolicy % approver cannot change', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF new_status <> old_status THEN
    IF old_status IN ('INACTIVE', 'REJECTED', 'WITHDRAWN') THEN
      RAISE EXCEPTION 'PlatformFeePolicy % is % and final', OLD."id", old_status
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF old_status = 'PENDING_APPROVAL' AND new_status NOT IN ('ACTIVE', 'REJECTED', 'WITHDRAWN') THEN
      RAISE EXCEPTION 'PlatformFeePolicy % waiting for approval cannot become %', OLD."id", new_status
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF new_status IN ('PENDING_APPROVAL', 'REJECTED', 'WITHDRAWN') AND old_status <> 'PENDING_APPROVAL' THEN
      RAISE EXCEPTION 'PlatformFeePolicy % cannot become %', OLD."id", new_status
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF new_status = 'ACTIVE' AND old_status = 'PENDING_APPROVAL'
       AND (NEW."approvedByUserId" IS NULL OR NEW."approvedByUserId" = NEW."createdByUserId") THEN
      RAISE EXCEPTION 'PlatformFeePolicy % needs an approver other than its creator', OLD."id"
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF new_status = 'INACTIVE'
       AND (NEW."deactivatedByUserId" IS NULL
            OR (NOT NEW."emergencyDeactivation"
                AND (NEW."deactivationRequestedByUserId" IS NULL
                     OR NEW."deactivationRequestedByUserId" = NEW."deactivatedByUserId"))) THEN
      RAISE EXCEPTION 'PlatformFeePolicy % can only be switched off by an approved request or the emergency path', OLD."id"
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "PlatformFeePolicy_guard"
  BEFORE INSERT OR UPDATE ON "PlatformFeePolicy"
  FOR EACH ROW EXECUTE FUNCTION "platform_fee_policy_guard"();

-- The policy history cannot be rewritten. (DELETE stays possible, as for AuditLog today:
-- test harnesses clean up their own rows; see AR-12.)
CREATE FUNCTION "platform_fee_policy_event_no_update"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'PlatformFeePolicyEvent is append-only: UPDATE refused'
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "PlatformFeePolicyEvent_no_update"
  BEFORE UPDATE ON "PlatformFeePolicyEvent"
  FOR EACH ROW EXECUTE FUNCTION "platform_fee_policy_event_no_update"();
