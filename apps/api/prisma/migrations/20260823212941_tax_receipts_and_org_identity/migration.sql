-- CreateEnum
CREATE TYPE "TaxBase" AS ENUM ('TICKETS', 'FEES', 'TICKETS_AND_FEES');

-- CreateEnum
CREATE TYPE "ReceiptKind" AS ENUM ('RECEIPT', 'TAX_INVOICE', 'CREDIT_NOTE');

-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "taxMinor" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "financeContactEmail" TEXT,
ADD COLUMN     "financeContactName" TEXT,
ADD COLUMN     "financeContactPhone" TEXT,
ADD COLUMN     "legalName" TEXT,
ADD COLUMN     "registeredAddressLine1" TEXT,
ADD COLUMN     "registeredAddressLine2" TEXT,
ADD COLUMN     "registeredCity" TEXT,
ADD COLUMN     "registeredCountry" TEXT,
ADD COLUMN     "registeredPostalCode" TEXT,
ADD COLUMN     "registeredRegion" TEXT,
ADD COLUMN     "taxRegistrationKind" TEXT,
ADD COLUMN     "taxRegistrationNumber" TEXT;

-- AlterTable
ALTER TABLE "Refund" ADD COLUMN     "taxMinor" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "TaxRule" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "rateBasisPoints" INTEGER NOT NULL,
    "appliesTo" "TaxBase" NOT NULL DEFAULT 'TICKETS',
    "country" TEXT NOT NULL DEFAULT '*',
    "region" TEXT NOT NULL DEFAULT '*',
    "currency" TEXT NOT NULL DEFAULT '*',
    "priority" INTEGER NOT NULL DEFAULT 100,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "effectiveFrom" TIMESTAMP(3),
    "effectiveTo" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaxRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingTaxLine" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "rateBasisPoints" INTEGER NOT NULL,
    "baseMinor" INTEGER NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BookingTaxLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Receipt" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "kind" "ReceiptKind" NOT NULL,
    "organizationId" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "saleForBookingId" TEXT,
    "refundId" TEXT,
    "reversesId" TEXT,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "currency" TEXT NOT NULL,
    "subtotalMinor" INTEGER NOT NULL,
    "discountMinor" INTEGER NOT NULL,
    "feeMinor" INTEGER NOT NULL,
    "taxMinor" INTEGER NOT NULL,
    "totalMinor" INTEGER NOT NULL,
    "documentJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Receipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReceiptCounter" (
    "scope" TEXT NOT NULL,
    "value" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ReceiptCounter_pkey" PRIMARY KEY ("scope")
);

-- CreateIndex
CREATE INDEX "TaxRule_active_country_region_idx" ON "TaxRule"("active", "country", "region");

-- CreateIndex
CREATE INDEX "BookingTaxLine_bookingId_idx" ON "BookingTaxLine"("bookingId");

-- CreateIndex
CREATE UNIQUE INDEX "Receipt_saleForBookingId_key" ON "Receipt"("saleForBookingId");

-- CreateIndex
CREATE UNIQUE INDEX "Receipt_refundId_key" ON "Receipt"("refundId");

-- CreateIndex
CREATE INDEX "Receipt_organizationId_issuedAt_idx" ON "Receipt"("organizationId", "issuedAt");

-- CreateIndex
CREATE INDEX "Receipt_bookingId_idx" ON "Receipt"("bookingId");

-- CreateIndex
CREATE UNIQUE INDEX "Receipt_organizationId_number_key" ON "Receipt"("organizationId", "number");

-- AddForeignKey
ALTER TABLE "BookingTaxLine" ADD CONSTRAINT "BookingTaxLine_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Receipt" ADD CONSTRAINT "Receipt_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Receipt" ADD CONSTRAINT "Receipt_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Receipt" ADD CONSTRAINT "Receipt_refundId_fkey" FOREIGN KEY ("refundId") REFERENCES "Refund"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Receipt" ADD CONSTRAINT "Receipt_reversesId_fkey" FOREIGN KEY ("reversesId") REFERENCES "Receipt"("id") ON DELETE SET NULL ON UPDATE CASCADE;

