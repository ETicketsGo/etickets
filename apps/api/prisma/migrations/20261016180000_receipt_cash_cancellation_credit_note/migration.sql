-- A credit note for a counter cash sale whose show was cancelled (F1).
--
-- Additive only. One nullable column, its unique index, a CHECK that keeps it to the one
-- shape it may take, and a trigger that refuses any edit to such a credit note once issued.
-- No existing row, column, constraint or rule changes: every refund credit note, sale receipt
-- and tax invoice already issued reads exactly as before.

-- AlterTable
ALTER TABLE "Receipt" ADD COLUMN "cancellationForBookingId" TEXT;

-- CreateIndex: at most one cancellation credit note per booking, enforced by the database, so
-- a cancellation retried by the sweep, the event cancel and the ShowCancelled handler at once
-- cannot issue two.
CREATE UNIQUE INDEX "Receipt_cancellationForBookingId_key" ON "Receipt"("cancellationForBookingId");

-- Only ever a credit note, never one keyed to a refund as well, and always about its own booking.
ALTER TABLE "Receipt" ADD CONSTRAINT "Receipt_cancellation_credit_note_shape"
  CHECK (
    "cancellationForBookingId" IS NULL
    OR (
      "kind" = 'CREDIT_NOTE'
      AND "refundId" IS NULL
      AND "saleForBookingId" IS NULL
      AND "cancellationForBookingId" = "bookingId"
    )
  );

-- Immutable once issued. The application has no update path for any Receipt; this makes that
-- a database fact for the new credit notes. Scoped to them on purpose, so no existing document
-- gains a rule it did not have. `reversesId` alone may change, because the foreign key to the
-- sale is ON DELETE SET NULL and that is the database's own bookkeeping, not an edit.
CREATE OR REPLACE FUNCTION "receipt_cancellation_credit_note_immutable"() RETURNS trigger AS $$
BEGIN
  IF OLD."cancellationForBookingId" IS NOT NULL AND (
       NEW."number" IS DISTINCT FROM OLD."number"
    OR NEW."kind" IS DISTINCT FROM OLD."kind"
    OR NEW."organizationId" IS DISTINCT FROM OLD."organizationId"
    OR NEW."bookingId" IS DISTINCT FROM OLD."bookingId"
    OR NEW."cancellationForBookingId" IS DISTINCT FROM OLD."cancellationForBookingId"
    OR NEW."refundId" IS DISTINCT FROM OLD."refundId"
    OR NEW."saleForBookingId" IS DISTINCT FROM OLD."saleForBookingId"
    OR NEW."issuedAt" IS DISTINCT FROM OLD."issuedAt"
    OR NEW."currency" IS DISTINCT FROM OLD."currency"
    OR NEW."subtotalMinor" IS DISTINCT FROM OLD."subtotalMinor"
    OR NEW."discountMinor" IS DISTINCT FROM OLD."discountMinor"
    OR NEW."feeMinor" IS DISTINCT FROM OLD."feeMinor"
    OR NEW."taxMinor" IS DISTINCT FROM OLD."taxMinor"
    OR NEW."totalMinor" IS DISTINCT FROM OLD."totalMinor"
    OR NEW."documentJson"::text IS DISTINCT FROM OLD."documentJson"::text
  ) THEN
    RAISE EXCEPTION 'An issued credit note cannot be changed (receipt %).', OLD."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "receipt_cancellation_credit_note_immutable"
  BEFORE UPDATE ON "Receipt"
  FOR EACH ROW EXECUTE FUNCTION "receipt_cancellation_credit_note_immutable"();
