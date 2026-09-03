-- Tickets we sell but do not admit: a seat sourced from another cinema's system carries
-- that system's barcode, because their scanner has never heard of ours.
ALTER TABLE "Ticket" ADD COLUMN "vendorBarcode" TEXT;
ALTER TABLE "Ticket" ADD COLUMN "vendorBarcodeFormat" TEXT;
ALTER TABLE "Ticket" ADD COLUMN "vendorName" TEXT;

-- A valid ticket that is not ours to scan. Separate from INVALID because the check-in log
-- is a record people read, and calling a paid ticket invalid would be false in it.
ALTER TYPE "CheckInResultType" ADD VALUE 'EXTERNAL';
