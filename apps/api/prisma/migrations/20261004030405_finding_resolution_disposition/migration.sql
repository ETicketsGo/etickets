-- CreateEnum
CREATE TYPE "SettlementFindingResolution" AS ENUM ('PROVIDER_CONFIRMED_SENT', 'PROVIDER_CONFIRMED_NOT_SENT', 'SETTLED_OUTSIDE_PLATFORM', 'CANNOT_ESTABLISH');

-- AlterTable
ALTER TABLE "SettlementReconciliationFinding" ADD COLUMN     "resolution" "SettlementFindingResolution",
ADD COLUMN     "resolutionEvidenceRef" TEXT;
