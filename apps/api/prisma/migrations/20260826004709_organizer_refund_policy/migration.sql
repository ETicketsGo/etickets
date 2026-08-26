-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "refundCutoffHours" INTEGER NOT NULL DEFAULT 48,
ADD COLUMN     "refundsEnabled" BOOLEAN NOT NULL DEFAULT true;

