-- "We do not know the treatment" and "we do not know the amount" are the same state of
-- knowledge, and the old constraint could not express it.
--
-- It said: NOT_APPLICABLE means zero, and anything else means more than zero. That was written
-- before UNCONFIRMED existed, when every treatment was a decision. It now forces a row for an
-- order nobody has read to pick between two false statements — invent an amount, or declare
-- that the jurisdiction has no maintenance charge.
--
-- Telangana hit exactly this. Both its rows carried Rs 5, copied from the constant the seed
-- uses for ANDHRA PRADESH's G.O.Ms.No.13, because zero was not storable. An Andhra Pradesh
-- figure was standing in for a Telangana one on the row for G.O.77, an order that is not in
-- this repository at all.
--
-- The rule that remains is the one that was actually protecting money: a treatment that
-- INSTRUCTS (included in the price, or added to it) must have an amount to act on, and
-- NOT_APPLICABLE must not carry one. UNCONFIRMED instructs nothing — the row cannot be
-- activated at all while it is set — so it may hold an amount or no amount.
ALTER TABLE "CinemaPricingPolicy" DROP CONSTRAINT "CinemaPricingPolicy_maintenance_coherent";

ALTER TABLE "CinemaPricingPolicy" ADD CONSTRAINT "CinemaPricingPolicy_maintenance_coherent"
  CHECK (
    ("maintenanceTreatment" = 'NOT_APPLICABLE' AND "maintenanceChargeMinor" = 0)
    OR ("maintenanceTreatment" = 'UNCONFIRMED' AND "maintenanceChargeMinor" >= 0)
    OR (
      "maintenanceTreatment" NOT IN ('NOT_APPLICABLE', 'UNCONFIRMED')
      AND "maintenanceChargeMinor" > 0
    )
  );
