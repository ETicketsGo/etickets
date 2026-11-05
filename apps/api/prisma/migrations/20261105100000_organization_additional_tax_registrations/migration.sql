-- Registrations beyond the main one. Nullable and additive: no existing row changes.
ALTER TABLE "Organization" ADD COLUMN "additionalTaxRegistrations" JSONB;
