-- The SES webhook now confirms an SNS subscription itself, in every environment, once the
-- signature, the topic allowlist and the SubscribeURL all check out (ADR-054).
--
-- Purely additive: nullable columns, one column with a default, and a unique index over a
-- column that is null on every existing row (Postgres treats nulls as distinct, so existing
-- rows cannot collide). An older API never reads or writes these columns, so it keeps working
-- against a migrated database.

ALTER TABLE "SnsPendingConfirmation" ADD COLUMN "tokenHash" TEXT;
ALTER TABLE "SnsPendingConfirmation" ADD COLUMN "confirmedAt" TIMESTAMP(3);
ALTER TABLE "SnsPendingConfirmation" ADD COLUMN "subscriptionArn" TEXT;
ALTER TABLE "SnsPendingConfirmation" ADD COLUMN "lastAttemptAt" TIMESTAMP(3);
ALTER TABLE "SnsPendingConfirmation" ADD COLUMN "lastFailure" TEXT;
ALTER TABLE "SnsPendingConfirmation" ADD COLUMN "attemptCount" INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX "SnsPendingConfirmation_topicArn_tokenHash_key" ON "SnsPendingConfirmation"("topicArn", "tokenHash");
