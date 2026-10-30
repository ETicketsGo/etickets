# ETicketsGo: product current state

> **As of 2026-10-30.** This is the master reference for what the product is and what state each
> part is in. When another document disagrees with this page about the _current_ state, this page
> wins. Dated reports, certifications and trackers stay as historical records.
>
> Sources: the code on `main` (`700c69f5`), `apps/api/prisma/schema.prisma`, merged PR titles
> (`git log --first-parent main`), and the release records of the team. A fact marked
> **(unverified)** comes from a report and was not checked against code or a running environment
> for this page.

## Status legend

| Status                       | Meaning                                                                      |
| ---------------------------- | ---------------------------------------------------------------------------- |
| **Live in production**       | Deployed to PROD and switched on for real users.                             |
| **Implemented but disabled** | The code is in PROD, but a flag, a missing setting or a policy keeps it off. |
| **QA certified**             | Proven on QA; not live in PROD (either not deployed or not switched on).     |
| **In development**           | Open PR or partial code; not on `main`, or on `main` but not finished.       |
| **Planned**                  | Decided or designed; no shipping code yet.                                   |
| **Blocked**                  | Cannot proceed until an external party or an owner action completes it.      |

---

## 1. Product overview and vision

ETicketsGo is a ticketing platform for **events and cinema**. It serves three audiences, each with
its own web app:

| Audience      | App                  | What they do                                                                                       |
| ------------- | -------------------- | -------------------------------------------------------------------------------------------------- |
| Customer      | `apps/customer-web`  | Discover events and films, choose seats or quantities, pay, get a QR ticket, follow organizers.    |
| Organizer     | `apps/organizer-web` | Create events and shows, venues and seat maps, ticket types, check-in, audience, payouts, reports. |
| Administrator | `apps/admin-web`     | Approve organizers and events, configure fees, handle refunds, payouts, suspensions and audit.     |

**Markets.** Two countries, each with a first launch city:

| Market | Launch city     | Currency | Payments           | Legal entity                                 |
| ------ | --------------- | -------- | ------------------ | -------------------------------------------- |
| India  | Hyderabad       | INR      | Razorpay (+ Route) | DeepTrics Software Solutions Private Limited |
| USA    | Meridian, Idaho | USD      | Stripe (+ Connect) | DeepTrics LLC                                |

Canada (CAD, French for Quebec) has code support (i18n, Twilio SMS routing) but is not a launch
market.

**Core capabilities.**

| Capability                                                          | Status                                                           |
| ------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Discovery (location-scoped catalogue, search, film and event pages) | Live in production                                               |
| Booking: seated (seat maps, GRID/sectioned) and general admission   | Live in production                                               |
| Free events (no payment step, no fee)                               | Live in production                                               |
| Paid online booking, India (Razorpay)                               | Live in production (first real UPI payment confirmed 2026-10-17) |
| Paid online booking, USA (Stripe)                                   | Implemented but disabled (never run against live Stripe)         |
| Guest checkout (emailed link)                                       | Live in production (unverified)                                  |
| QR tickets, wallet, camera and manual check-in, offline devices     | Live in production                                               |
| Customer and organizer notifications (email, India SMS)             | Live in production (see section 5)                               |
| Organizer console (events, scheduling, venues, attendees, reports)  | Live in production                                               |
| Admin console (approvals, suspension, fees, refunds, audit, MFA)    | Live in production                                               |
| Organizer acquisition CRM (admin)                                   | Live in production (unverified)                                  |

**Growth and monetization strategy.** Revenue comes from a platform fee on paid tickets (free
events pay nothing). Growth comes from organizers bringing their audience: customers follow
organizers, organizers reach followers who consented, and paid organizer plans (subscriptions and
entitlements) are built for later. Billing and campaigns stay off in production until the owner
approves them.

---

## 2. Technology architecture

Verified from the repository.

| Layer            | Choice                                                                                         |
| ---------------- | ---------------------------------------------------------------------------------------------- |
| Monorepo         | Turborepo + npm workspaces, strict TypeScript                                                  |
| API              | `apps/api`: NestJS 11 (Express 5) modular monolith, REST + OpenAPI                             |
| Worker           | `apps/worker`: NestJS + BullMQ (expiry, outbox dispatch, notifications, settlement, reminders) |
| Web apps         | `apps/customer-web`, `apps/organizer-web`, `apps/admin-web`: Next.js 15, React 18, Tailwind    |
| Android app      | `apps/customer-mobile`: Expo SDK 57, React Native 0.86, app version 1.0.0                      |
| iOS app          | Native SwiftUI app, only in open PRs #458/#459 (not on `main`)                                 |
| Shared packages  | `packages/config`, `design-tokens`, `i18n`, `shared-types`, `validation`, `web-kit`            |
| End-to-end tests | `apps/e2e` (Playwright)                                                                        |
| Database         | PostgreSQL + Prisma 5; 151 migrations                                                          |
| Queue and cache  | Redis + BullMQ (seat holds, queues, rate limits)                                               |
| Email            | Amazon SES, delivery events via SNS webhook                                                    |
| SMS              | MSG91 (India, DLT), Twilio (US and Canada)                                                     |
| Payments         | Razorpay (INR, Route for payouts), Stripe (USD, Connect for payouts)                           |
| Hosting          | Railway: QA, UAT and PROD environments, five services each (api, worker, three web apps)       |

---

## 3. Pricing and finance

### Platform fee types

The fee engine (`FeeRule.feeType`, `apps/api/src/pricing/`) supports:

| Fee model                                    | Code                          | Example                        | Status             |
| -------------------------------------------- | ----------------------------- | ------------------------------ | ------------------ |
| Free events: zero fee                        | (no charge)                   | Rs 0 on a free ticket          | Live in production |
| Fixed per order                              | `FLAT`                        | Rs 20 per order                | Live in production |
| Fixed per paid ticket                        | `FIXED_PER_TICKET`            | Rs 5 x 3 tickets = Rs 15       | Live in production |
| Percentage of the order                      | `PERCENT`                     | 3%                             | Live in production |
| Percentage plus fixed per paid ticket        | `COMBINED`                    | 3% + Rs 5 per ticket           | Live in production |
| Optional minimum and maximum fee on any band | `minFeeMinor` / `maxFeeMinor` | at least Rs 10, at most Rs 100 | Live in production |

Bands are scoped by currency, country and region. Payment processing is its own line on the
receipt, never inside "Convenience fees".

### Fee schedule changes

| Behaviour                                                                                                     | Status                                                          |
| ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Draft, validate, preview, publish: a draft prices nothing; publish writes all bands in one transaction (#531) | Live in production                                              |
| Publishing needs admin MFA; each published draft is kept as a version (history is never edited)               | Live in production                                              |
| Every draft save is audited, not only publish (#533)                                                          | Live in production (api only)                                   |
| Single-band write endpoints retired; bands change only by publish (#532)                                      | Live in production                                              |
| Quote and booking carry the fee-schedule version; a booking refuses if the schedule changed after the quote   | Live in production                                              |
| Precedence: event override, then organizer override, then the published schedule (`PlatformFeePolicy`)        | Live in production (0 policies configured in PROD (unverified)) |
| Concurrent drafts are allowed (no database constraint); accepted by the owner                                 | Live in production                                              |

### Refunds, settlement and payouts

| Behaviour                                                                                 | Status                                                                    |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Refunds are approved in the admin console and executed against the provider; audited      | Live in production                                                        |
| R1 fix: a refund reduces the organizer's settled share correctly (#521)                   | Live in production                                                        |
| Settlement runs and payout allocation ledger (per-event scoping, ownership certification) | Live in production                                                        |
| Organizer payout setup (bank details, maker-checker, country gates)                       | Live in production                                                        |
| Provider payout transfers (Razorpay Route, Stripe Connect)                                | Implemented but disabled                                                  |
| India GST on the platform fee                                                             | Implemented but disabled (rules inactive; activating raises buyer totals) |

### Subscriptions and entitlements

| Behaviour                                                                                                       | Status                                                        |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Plans, prices, entitlement overrides, billing payments and webhooks (`BillingPlan`, `EntitlementOverride`, ...) | Implemented but disabled                                      |
| Billing providers (Razorpay / Stripe subscriptions)                                                             | Implemented but disabled (`BILLING_*` unset in PROD; 0 plans) |
| Invoice numbering: India `ETGB-<FY>-NNNNNN`, US `ETG-BIL-US-YYYY-NNNNNN`                                        | Implemented but disabled                                      |
| Whether plan prices include tax                                                                                 | Blocked (owner decision)                                      |

See [commercial/PLATFORM-FEES.md](commercial/PLATFORM-FEES.md) and
[billing/BILLING-PROVIDERS.md](billing/BILLING-PROVIDERS.md).

---

## 4. Audience and growth

| Capability                                                                                            | Status                                                                 |
| ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Follow an organizer (`OrganizerFollow`)                                                               | Live in production                                                     |
| Per-follow notification preferences                                                                   | Live in production                                                     |
| Consent and unsubscribe precedence: an account-level opt-out or unsubscribe beats a follow preference | Live in production                                                     |
| Signed unsubscribe links (`UNSUBSCRIBE_SIGNING_SECRET`)                                               | Live in production                                                     |
| Basic audience view and segmentation for organizers                                                   | Live in production                                                     |
| Campaigns (compose, send, link tracking, analytics)                                                   | QA certified; disabled in PROD (`CAMPAIGNS_ENABLED` unset)             |
| Marketing sender `updates@` in SES                                                                    | Blocked (owner SES setup)                                              |
| Campaign send in PROD                                                                                 | Blocked (verified postal addresses for both entities + owner approval) |

Suppression rules: a complaint suppresses marketing only; a hard bounce suppresses all email.
See [engagement/MARKETING-EMAIL.md](engagement/MARKETING-EMAIL.md) and
[release/GROWTH-EXTERNAL-SETUP.md](release/GROWTH-EXTERNAL-SETUP.md).

---

## 5. Notifications

### India SMS (MSG91, DLT)

| Item                                                                                                      | Status                               |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Login OTP by SMS via MSG91, sender header `ETKTGO`, code valid 5 minutes                                  | Live in production                   |
| Eight approved DLT templates mapped to MSG91 template ids                                                 | Live in production (configuration)   |
| `BOOKING_CONFIRMED` SMS                                                                                   | Live in production                   |
| `BOOKING_CANCELLED` SMS (free and paid cancellations, #530)                                               | Live in production                   |
| `PASSWORD_CHANGED` SMS                                                                                    | Live in production                   |
| `EVENT_REMINDER` SMS: type enabled, but the reminders job is off (`NOTIFICATION_REMINDERS_ENABLED` unset) | Implemented but disabled             |
| `PASSWORD_RESET` SMS (email only today)                                                                   | Implemented but disabled (deferred)  |
| `PAYMENT_PENDING` SMS (template approved; no notification type)                                           | Planned (deferred)                   |
| `PASSWORD_UPDATE` (template approved; not sent, one SMS per password change)                              | Implemented but disabled (by design) |
| SMS to guest buyers (no guest phone captured)                                                             | Planned (deferred)                   |
| Delivery receipts: MSG91 webhook, correlated by MSG91 request id                                          | Live in production                   |

Production enables these types through `SMS_TRANSACTIONAL_TYPES`, and
`SMS_TRANSACTIONAL_MARKETS` defaults to `IN`. Template texts and ids:
[notifications/INDIA-DLT-TEMPLATES.md](notifications/INDIA-DLT-TEMPLATES.md).

### USA and Canada SMS (Twilio)

| Item                                               | Status                                                                        |
| -------------------------------------------------- | ----------------------------------------------------------------------------- |
| Login OTP via Twilio (US and CA routing unchanged) | Live in production                                                            |
| New transactional SMS types for +1 numbers         | Implemented but disabled (`SMS_TRANSACTIONAL_MARKETS` does not include US/CA) |
| A2P 10DLC registration                             | Live in production (low-volume brand verified (unverified))                   |

### Email and other channels

| Item                                                                       | Status                                      |
| -------------------------------------------------------------------------- | ------------------------------------------- |
| Transactional email via Amazon SES (bookings, receipts, password, support) | Live in production                          |
| SES bounce and complaint handling via SNS webhook, suppression list        | Live in production                          |
| Marketing email via SES (separate sender and configuration)                | Blocked (owner SES setup)                   |
| WhatsApp (MSG91 or Meta Cloud)                                             | Planned (configuration-dependent; not live) |
| Mobile push (FCM / Expo)                                                   | Planned (unverified)                        |

---

## 6. Legal and business identity

| Rule                                                                                       | Status             |
| ------------------------------------------------------------------------------------------ | ------------------ |
| India operator: **DeepTrics Software Solutions Private Limited**                           | Live in production |
| USA operator: **DeepTrics LLC**                                                            | Live in production |
| The footer and legal pages show the entity of the visitor's market (#515, #519, #529)      | Live in production |
| No address, registration id or tax detail is shown until the owner supplies a verified one | Live in production |

There is no "DeepTrics Inc" and there is no single company for both markets. Never add an address,
CIN, GSTIN, EIN or similar to a page or template without the owner's verified value. See
[PRODUCTION_BUSINESS_DETAILS_CHECKLIST.md](PRODUCTION_BUSINESS_DETAILS_CHECKLIST.md).

---

## 7. Mobile

| Item                                                                                      | Status                                                                                                                                 |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Android app (`apps/customer-mobile`), release candidate 1.0.0 (versionCode 4), signed AAB | QA certified                                                                                                                           |
| Android release on Google Play                                                            | Blocked (not uploaded; DeepTrics Software Solutions Private Limited organization developer account, verification pending (unverified)) |
| Play Integrity as a second human check in the API                                         | Implemented but disabled (needs `PLAY_INTEGRITY_*` settings)                                                                           |
| iOS native SwiftUI app, Phase 1 foundation (PR #458)                                      | In development (PR open)                                                                                                               |
| iOS Phase 2A authentication (PR #459, stacked on #458)                                    | In development (PR open)                                                                                                               |
| iOS App Store release                                                                     | Planned                                                                                                                                |
| Installable PWA (storefront as a web app on Android)                                      | Live in production                                                                                                                     |

Play steps: [apps/customer-mobile/docs/PLAY-RELEASE.md](../apps/customer-mobile/docs/PLAY-RELEASE.md).

---

## 8. Production state

| Item                                           | Value                                                                 |
| ---------------------------------------------- | --------------------------------------------------------------------- |
| api                                            | `700c69f5` (main, includes #533 draft-save audit)                     |
| worker, customer-web, organizer-web, admin-web | `76c304da` (#527 to #532)                                             |
| Migrations                                     | 151 applied, 0 failed                                                 |
| Backups                                        | Nightly verified `pg_dump`, plus a pre-deploy backup for each release |
| Payout transfers                               | Disabled                                                              |
| Billing                                        | Disabled                                                              |
| Campaigns                                      | Disabled                                                              |
| India SMS                                      | OTP + three transactional types live; reminders off                   |
| Coupons                                        | Disabled (unverified)                                                 |
| Admin MFA enrolment                            | Deferred in PROD (unverified); fee publish requires MFA               |

QA runs `main` on all five services. UAT is a separate isolated environment.

---

## 9. Known blockers

| Blocker                                                         | Owner of next step  | Blocks                     |
| --------------------------------------------------------------- | ------------------- | -------------------------- |
| Verified postal addresses for both legal entities               | Owner               | Campaigns, marketing email |
| SES marketing sender (`updates@`) and its IAM permission        | Owner               | Campaigns                  |
| Tax treatment of plan prices; GST activation decision           | Owner               | Billing; GST on fees       |
| Stripe live account and Connect onboarding for US organizers    | Owner               | Paid sales in Meridian     |
| Razorpay Route activation and post-transfer gate                | Owner + engineering | Automated India payouts    |
| Google Play organization account verification and store listing | Owner               | Android release            |
| iOS PRs #458/#459 review; Apple developer account (unverified)  | Owner + engineering | iOS release                |
| Public sale approval and real organizer events in PROD          | Owner               | Launch in both cities      |

---

## 10. Next priorities

1. Onboard the first real organizers and events in Hyderabad and Meridian.
2. Stripe live mode and Connect payout onboarding for US organizers.
3. Owner supplies verified addresses and the SES marketing sender; then a controlled first campaign.
4. Decide reminder SMS (`NOTIFICATION_REMINDERS_ENABLED`) and the deferred SMS types.
5. Android Play release from the organization account; iOS foundation review.
6. Keep the payout-transfer gate closed until the post-transfer checks are proven.

Launch checklist: [release/LAUNCH-READINESS-CHECKLIST.md](release/LAUNCH-READINESS-CHECKLIST.md).
