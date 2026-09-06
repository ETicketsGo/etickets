-- The accent palette an organization's workspace is rendered in.
--
-- Nullable with no default: null means "has not chosen", which renders exactly as the console
-- did before themes existed. Backfilling every row with 'default' would claim thousands of
-- organizations had made a choice they never made, and would make "reset to the platform
-- look" indistinguishable from "never picked one".
ALTER TABLE "Organization" ADD COLUMN "consoleTheme" TEXT;
