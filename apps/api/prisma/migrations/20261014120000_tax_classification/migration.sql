-- A dedicated tax classification (H-8). Additive and nullable: no backfill, because any
-- value written here for an existing event would be a guess at its tax category, which is
-- exactly what this column exists to stop. GST stays inactive; with no active classified
-- TaxRule nothing reads these columns at checkout.
ALTER TABLE "Event" ADD COLUMN "taxCategory" TEXT;
ALTER TABLE "TicketType" ADD COLUMN "taxCategory" TEXT;
ALTER TABLE "BookingItem" ADD COLUMN "taxCategory" TEXT;
