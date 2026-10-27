# Production release request: growth & monetization (prepared 2026-10-27, NOT approved, NOT run)

## 1. Where production is (read-only, 2026-10-27)

| Service       | Running    | Rollback deployment                    |
| ------------- | ---------- | -------------------------------------- |
| api           | `8a769671` | `0d3b3b62-999b-49fb-b9d5-693b25671d1d` |
| worker        | `8a769671` | `e8beb6cf-2838-468d-9ef5-6c6ebb4e06ec` |
| customer-web  | `8a769671` | `ab54f9ac-ab76-4878-b540-39ee9b3a7d14` |
| organizer-web | `8a769671` | `458ff289-33be-4a7d-8d9b-a1dccc02b78a` |
| admin-web     | `8a769671` | `36f01f88-147a-45f5-9180-e74514bf9cfa` |

Database: Postgres 16, 138 migrations, 0 failed. None of the growth tables exist.

## 2. Target and scope

`main` at `b9d9355c` (QA-certified, rounds 1-3), plus docs-only commits after it. Scope:

- #500 phone-only accounts can add an email on the profile;
- #501 platform fee policies (waivers/overrides);
- #502 real organizer follows, scoped consent, signed one-click unsubscribe;
- #503 entitlements and organizer billing core;
- #504 email campaigns and audience analytics;
- #505 Stripe Billing / Razorpay Subscriptions providers;
- #507 owner decisions;
- #508 certification fixes.

What changes for users the moment it is deployed, with no further configuration:

- **Follow becomes real.** The fake (browser-only) Follow button and Following page are replaced. Old local follows move to the account once.
- **Organizer console** gains the Audience & growth, Email campaigns and Billing & plans tabs:
  - Campaigns says they are not available (`CAMPAIGNS_ENABLED` unset).
  - Billing says paid plans are not open yet (`BILLING_ENABLED` unset).
- **Admin** gains:
  - Platform fee policies (no policy exists, so no fee changes);
  - Billing & subscriptions (the catalogue is not loaded until an admin loads it);
  - campaign oversight.
- **Complaints** suppress marketing only. The one existing production COMPLAINT suppression becomes marketing-only, so that address gets transactional email again (owner decision).

Nothing in this release changes bookings, payments, refunds, payouts or Razorpay ticket configuration. The fee engine only differs when an active fee policy exists. Free events stay at zero.

## 3. Migrations (6, applied in order by the api deploy)

| Migration                                  | Effect on existing data                                                                                                                                                                                                       |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `20261027100000_organizer_follow_consent`  | New tables only                                                                                                                                                                                                               |
| `20261027110000_platform_fee_policy`       | New tables; 5 nullable `Booking` columns + FK + CHECK (no backfill; 11 bookings, all NULL)                                                                                                                                    |
| `20261027120000_entitlements_billing_core` | New tables, append-only triggers on the new ledger/invoice tables                                                                                                                                                             |
| `20261027130000_organizer_campaigns`       | New tables only                                                                                                                                                                                                               |
| `20261028120000_billing_providers`         | New tables/columns on new tables; `NotificationType` += `BILLING_PAYMENT_FAILED`                                                                                                                                              |
| `20261028200000_growth_owner_decisions`    | `TaxBase` += `PLATFORM_SERVICES`; `SuppressedDestination` gets `scope` (default `ALL`), unique key becomes (channel, destinationHash, scope), COMPLAINT rows set to `MARKETING` (1 row in production); new credit pack tables |

Production compatibility (checked read-only):

- no duplicate (channel, destinationHash) rows, so the new unique index builds;
- 3 suppression rows in total;
- the enum values do not already exist;
- the same 6 migrations applied cleanly on QA (144 total, 0 failed).

Rollback compatibility: the old code (`8a769671`) ignores every new table and nullable column. For `SuppressedDestination` it reads by (channel, destinationHash) without needing the dropped index and inserts with `skipDuplicates`, which the new index satisfies. After a rollback, a marketing-scope row would again block all email for that address (the old behaviour). No migration needs to be undone to roll back.

## 4. Configuration

| Variable (api + worker)                                                              | Production now                                                                                                   | Needed for                                                                                        |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `UNSUBSCRIBE_SIGNING_SECRET`                                                         | **SET** 2026-10-27 (64 hex characters, generated and stored in Railway, never printed; inert until this release) | signing unsubscribe links (campaigns refuse to send without it)                                   |
| `CAMPAIGNS_ENABLED`, `FEATURE_MARKETING_AUTOMATION`                                  | unset (off)                                                                                                      | switching campaigns on: separate approval                                                         |
| `MARKETING_EMAIL_FROM` (`updates@eticketsgo.com`), `SES_MARKETING_CONFIGURATION_SET` | unset                                                                                                            | campaigns; needs the SES IAM change first                                                         |
| `MARKETING_POSTAL_ADDRESS_IN`, `MARKETING_POSTAL_ADDRESS_US`                         | unset                                                                                                            | campaigns; production refuses each campaign whose country has no address                          |
| `BILLING_ENABLED`, `BILLING_PROVIDER`                                                | unset (off)                                                                                                      | paid plans; production boot refuses billing until a production provider configuration is approved |
| `PLATFORM_TAX_REGION`, `STRIPE_BILLING_AUTOMATIC_TAX`                                | unset                                                                                                            | billing tax; checkout refuses without them                                                        |

The new code boots in production with all of the above unset. The boot checks only refuse contradictory billing states (`configuration.billing.spec`, 221/221 config specs pass). Campaigns and billing then answer "not enabled".

## 5. Procedure (after approval; kit `C:/etg-wt/prod-deploy-kit`, from the repo checkout)

1. Fresh `predeploy-backup.sh` with `RESULT: restored copy matches live`, plus an off-Railway copy.
2. Pinned deploys, one at a time, stop on the first failure: api (runs the 6 migrations), worker, customer-web, organizer-web, admin-web.
3. Checks:
   - `_prisma_migrations` 144, 0 failed;
   - health/ready 200;
   - storefront pages 200;
   - Follow works for a real account;
   - organizer tabs show the not-enabled messages;
   - admin pages load;
   - campaign and billing endpoints answer not-enabled;
   - booking/payment/refund/payout counts unchanged;
   - capabilities unchanged.

## 6. Rollback

`CONFIRM_PROD_ROLLBACK=<service>@<id> node rollback.mjs PROD <service> <id> 8a769671` per service, with the ids in section 1. The migrations stay (section 3).
