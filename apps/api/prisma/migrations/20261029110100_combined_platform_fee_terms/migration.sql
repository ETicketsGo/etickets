-- Each policy kind carries exactly the amounts it needs; COMBINED needs both a percentage and a
-- per-ticket fixed amount, and a currency because it states an amount. The three existing
-- clauses are unchanged, so every existing row still satisfies the constraint.

ALTER TABLE "PlatformFeePolicy" DROP CONSTRAINT "PlatformFeePolicy_terms_check";
ALTER TABLE "PlatformFeePolicy" ADD CONSTRAINT "PlatformFeePolicy_terms_check"
  CHECK (
    ("kind" = 'WAIVE' AND "feeMinor" IS NULL AND "percentBps" IS NULL)
    OR ("kind" = 'FIXED' AND "feeMinor" IS NOT NULL AND "feeMinor" >= 0 AND "percentBps" IS NULL AND "currency" IS NOT NULL)
    OR ("kind" = 'PERCENT' AND "percentBps" IS NOT NULL AND "percentBps" BETWEEN 0 AND 10000 AND "feeMinor" IS NULL)
    OR ("kind" = 'COMBINED' AND "percentBps" IS NOT NULL AND "percentBps" BETWEEN 0 AND 10000 AND "feeMinor" IS NOT NULL AND "feeMinor" >= 0 AND "currency" IS NOT NULL)
  );
