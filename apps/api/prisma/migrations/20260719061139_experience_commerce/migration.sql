-- CreateEnum
CREATE TYPE "AddOnType" AS ENUM ('MERCHANDISE', 'PARKING', 'FOOD_BEVERAGE', 'VIP_UPGRADE', 'MEET_GREET', 'DONATION', 'DIGITAL');

-- CreateEnum
CREATE TYPE "BundleType" AS ENUM ('VIP', 'FAMILY', 'COMBO', 'EARLY_BIRD');

-- CreateEnum
CREATE TYPE "BundlePricingKind" AS ENUM ('FIXED', 'PERCENT_DISCOUNT');

-- CreateEnum
CREATE TYPE "BookingItemKind" AS ENUM ('TICKET', 'ADDON', 'BUNDLE');

-- DropForeignKey
ALTER TABLE "BookingItem" DROP CONSTRAINT "BookingItem_ticketTypeId_fkey";

-- AlterTable
ALTER TABLE "BookingItem" ADD COLUMN     "addOnId" TEXT,
ADD COLUMN     "bundleId" TEXT,
ADD COLUMN     "kind" "BookingItemKind" NOT NULL DEFAULT 'TICKET',
ADD COLUMN     "label" TEXT,
ALTER COLUMN "ticketTypeId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "AddOn" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "type" "AddOnType" NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "priceMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "imageUrl" TEXT,
    "maxPerOrder" INTEGER NOT NULL DEFAULT 10,
    "salesStartAt" TIMESTAMP(3),
    "salesEndAt" TIMESTAMP(3),
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AddOn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AddOnInventory" (
    "id" TEXT NOT NULL,
    "addOnId" TEXT NOT NULL,
    "quantityTotal" INTEGER,
    "quantitySold" INTEGER NOT NULL DEFAULT 0,
    "quantityHeld" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AddOnInventory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Bundle" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "type" "BundleType" NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "pricingKind" "BundlePricingKind" NOT NULL DEFAULT 'FIXED',
    "priceMinor" INTEGER,
    "discountPercent" INTEGER,
    "maxPerOrder" INTEGER NOT NULL DEFAULT 5,
    "salesStartAt" TIMESTAMP(3),
    "salesEndAt" TIMESTAMP(3),
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Bundle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BundleItem" (
    "id" TEXT NOT NULL,
    "bundleId" TEXT NOT NULL,
    "ticketTypeId" TEXT,
    "addOnId" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "BundleItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AddOn_eventId_idx" ON "AddOn"("eventId");

-- CreateIndex
CREATE INDEX "AddOn_eventId_enabled_idx" ON "AddOn"("eventId", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "AddOnInventory_addOnId_key" ON "AddOnInventory"("addOnId");

-- CreateIndex
CREATE INDEX "Bundle_eventId_idx" ON "Bundle"("eventId");

-- CreateIndex
CREATE INDEX "Bundle_eventId_enabled_idx" ON "Bundle"("eventId", "enabled");

-- CreateIndex
CREATE INDEX "BundleItem_bundleId_idx" ON "BundleItem"("bundleId");

-- CreateIndex
CREATE INDEX "BookingItem_addOnId_idx" ON "BookingItem"("addOnId");

-- CreateIndex
CREATE INDEX "BookingItem_bundleId_idx" ON "BookingItem"("bundleId");

-- AddForeignKey
ALTER TABLE "BookingItem" ADD CONSTRAINT "BookingItem_ticketTypeId_fkey" FOREIGN KEY ("ticketTypeId") REFERENCES "TicketType"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingItem" ADD CONSTRAINT "BookingItem_addOnId_fkey" FOREIGN KEY ("addOnId") REFERENCES "AddOn"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingItem" ADD CONSTRAINT "BookingItem_bundleId_fkey" FOREIGN KEY ("bundleId") REFERENCES "Bundle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AddOn" ADD CONSTRAINT "AddOn_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AddOnInventory" ADD CONSTRAINT "AddOnInventory_addOnId_fkey" FOREIGN KEY ("addOnId") REFERENCES "AddOn"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bundle" ADD CONSTRAINT "Bundle_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BundleItem" ADD CONSTRAINT "BundleItem_bundleId_fkey" FOREIGN KEY ("bundleId") REFERENCES "Bundle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BundleItem" ADD CONSTRAINT "BundleItem_ticketTypeId_fkey" FOREIGN KEY ("ticketTypeId") REFERENCES "TicketType"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BundleItem" ADD CONSTRAINT "BundleItem_addOnId_fkey" FOREIGN KEY ("addOnId") REFERENCES "AddOn"("id") ON DELETE SET NULL ON UPDATE CASCADE;
