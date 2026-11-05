-- Match a sign-in code's text message with the provider's delivery report.
--
-- Phone sign-in codes are sent through the SMS channel directly (never a Notification row, so
-- the code is never stored). MSG91's delivery reports therefore had nothing to match and were
-- held as AWAITING_CORRELATION. The provider's message id is now kept on the code's own row.
--
-- Purely additive: four nullable columns and one index. No existing row changes, and nothing
-- here holds the code or anything derived from it.

ALTER TABLE "PhoneOtp" ADD COLUMN IF NOT EXISTS "provider" TEXT;
ALTER TABLE "PhoneOtp" ADD COLUMN IF NOT EXISTS "providerMessageId" TEXT;
ALTER TABLE "PhoneOtp" ADD COLUMN IF NOT EXISTS "deliveryStatus" TEXT;
ALTER TABLE "PhoneOtp" ADD COLUMN IF NOT EXISTS "deliveredAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "PhoneOtp_provider_providerMessageId_idx"
  ON "PhoneOtp"("provider", "providerMessageId");
