-- AlterTable
ALTER TABLE "TaxRule" ADD COLUMN     "category" TEXT NOT NULL DEFAULT '*',
ADD COLUMN     "inclusive" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "maxUnitMinor" INTEGER,
ADD COLUMN     "minUnitMinor" INTEGER,
ADD COLUMN     "split" TEXT NOT NULL DEFAULT 'NONE',
ADD COLUMN     "taxGroup" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "Venue" ADD COLUMN     "region" TEXT;

