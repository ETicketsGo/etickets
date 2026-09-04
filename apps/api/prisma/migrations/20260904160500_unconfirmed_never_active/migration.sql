-- An ACTIVE policy may never carry an unresolved maintenance treatment.
--
-- Separate migration because PostgreSQL will not let a new enum value be used in the same
-- transaction that added it. Splitting them is not tidiness — a single file fails outright.
--
-- The rule: knowing an amount is not knowing what to do with it. ₹5 UNCONFIRMED is "somebody
-- said five rupees"; it is not a pricing instruction, and pricing a real order from it would
-- either over-charge the customer by five rupees or under-collect a statutory charge by the
-- same amount, with nothing on the record saying which was intended.
--
-- Enforced in the DATABASE and not only in the service, because a row can reach ACTIVE
-- through a migration, a console or an admin screen written later, and every one of those
-- prices real money.
ALTER TABLE "CinemaPricingPolicy" DROP CONSTRAINT IF EXISTS "CinemaPricingPolicy_maintenance_coherent";

ALTER TABLE "CinemaPricingPolicy" ADD CONSTRAINT "CinemaPricingPolicy_maintenance_coherent"
  CHECK (
    ("maintenanceTreatment" = 'NOT_APPLICABLE' AND "maintenanceChargeMinor" = 0)
    OR ("maintenanceTreatment" <> 'NOT_APPLICABLE' AND "maintenanceChargeMinor" > 0)
  );

ALTER TABLE "CinemaPricingPolicy" ADD CONSTRAINT "CinemaPricingPolicy_unconfirmed_never_active"
  CHECK (NOT ("status" = 'ACTIVE' AND "maintenanceTreatment" = 'UNCONFIRMED'));
