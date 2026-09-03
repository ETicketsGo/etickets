-- DropIndex
DROP INDEX "FeeRule_active_idx";

-- AlterTable
ALTER TABLE "FeeRule" ADD COLUMN     "country" TEXT NOT NULL DEFAULT '*',
ADD COLUMN     "region" TEXT NOT NULL DEFAULT '*';

-- CreateIndex
CREATE INDEX "FeeRule_active_country_region_idx" ON "FeeRule"("active", "country", "region");

