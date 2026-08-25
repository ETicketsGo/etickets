-- AlterTable
ALTER TABLE "Coupon" ADD COLUMN     "isPublic" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "publicLabel" TEXT;

-- CreateIndex
CREATE INDEX "Coupon_isPublic_status_idx" ON "Coupon"("isPublic", "status");

