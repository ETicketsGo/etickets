-- CreateEnum
CREATE TYPE "VenueLayoutKind" AS ENUM ('GRID', 'SECTIONED');

-- CreateEnum
CREATE TYPE "FocalPointKind" AS ENUM ('SCREEN', 'STAGE_END', 'STAGE_THRUST', 'STAGE_CENTRE', 'FIELD');

-- AlterTable
ALTER TABLE "SeatMap" ADD COLUMN     "focalLabel" TEXT,
ADD COLUMN     "focalPoint" "FocalPointKind" NOT NULL DEFAULT 'SCREEN',
ADD COLUMN     "focalShape" JSONB,
ADD COLUMN     "layoutKind" "VenueLayoutKind" NOT NULL DEFAULT 'GRID';

-- AlterTable
ALTER TABLE "SeatSection" ADD COLUMN     "labelX" INTEGER,
ADD COLUMN     "labelY" INTEGER,
ADD COLUMN     "rotationDeg" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "shape" JSONB,
ADD COLUMN     "tier" TEXT;

