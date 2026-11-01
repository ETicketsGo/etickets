# ETicketsGo: Key Flows (as built)

Status: current reference, written 2026-11-01 against `main` at `d5144d3f`. Each diagram was
traced from the code. The files are listed under each diagram. Paths without a prefix are under
`apps/api/src/`. Steps marked "unverified" were not traced to the end.

Older diagrams in [docs/diagrams/SEQUENCE-DIAGRAMS.md](../diagrams/SEQUENCE-DIAGRAMS.md) show
the July 2026 mock-payment design. Use this file for the current behaviour.

Contents:

1. [Ticket purchase](#1-ticket-purchase)
2. [Refund and the organizer settlement share (R1)](#2-refund-and-the-organizer-settlement-share-r1)
3. [Fee schedule draft, validate, publish](#3-fee-schedule-draft-validate-publish)
4. [Organizer subscription checkout, billing webhooks and dunning](#4-organizer-subscription-checkout-billing-webhooks-and-dunning)
5. [Phone OTP through MSG91 with delivery-report correlation](#5-phone-otp-through-msg91-with-delivery-report-correlation)
6. [Transactional email and SMS with suppression](#6-transactional-email-and-sms-with-suppression)
7. [Marketing campaign send guard](#7-marketing-campaign-send-guard)
8. [Payout onboarding and the transfer gate](#8-payout-onboarding-and-the-transfer-gate)

## 1. Ticket purchase

```mermaid
sequenceDiagram
  autonumber
  actor B as Buyer
  participant W as customer-web or mobile
  participant API as api
  participant PG as PostgreSQL
  participant P as Razorpay or Stripe
  participant WK as worker

  B->>W: choose tickets or seats
  W->>API: POST /bookings/quote
  API->>PG: read FeeRule bands, PlatformFeePolicy (event, then organization)
  API-->>W: fees, taxes, feeScheduleVersion (fingerprint of active bands)
  W->>API: POST /bookings with feeScheduleVersion and Idempotency-Key
  alt version differs from the live fingerprint
    API-->>W: 409 FEE_SCHEDULE_CHANGED (client quotes again)
  else version matches
    API->>PG: one transaction - Booking PENDING_PAYMENT with fee and tax snapshot,<br/>BookingItems, holdExpiresAt, Payment REQUIRES_PAYMENT, reserve seats or stock
    API-->>W: booking id and hold expiry
  end
  W->>API: POST /bookings/:id/pay
  API->>API: routeProviderForBooking - INR to Razorpay, USD and CAD to Stripe
  alt Razorpay
    API->>P: create order
  else Stripe
    API->>API: Connect gate - organizer account must have charges enabled
    API->>P: create payment through PaymentOrchestrator and PaymentRoute rows
  end
  API->>PG: Payment PROCESSING with providerRef and marketplace split
  API-->>W: checkout parameters
  B->>P: pays (card, UPI, wallet)
  P->>API: webhook POST /payments/webhooks/razorpay or /stripe
  API->>API: verify signature on the raw body
  API->>PG: WebhookEvent unique (provider, providerEventId) - duplicate is a no-op
  API->>API: processVerifiedEvent - check amount and currency
  API->>PG: one transaction - Booking PENDING_PAYMENT to CONFIRMED (guarded claim),<br/>booking reference, receipt, tickets ACTIVE, Payment SUCCEEDED,<br/>coupon redemption, BookingConfirmed event, Notification rows
  API-->>P: 200
  WK->>PG: dispatch-notifications picks the PENDING rows
  WK->>B: confirmation email (and SMS where the policy allows)
  Note over WK,PG: expire-holds releases unpaid holds. Before release it asks the<br/>provider, and a captured payment is recovered instead of released.
```

Files: `bookings/bookings.controller.ts`, `bookings/bookings.service.ts` (`quote`, `create`,
`releaseExpiredHolds`), `pricing/pricing.service.ts` (`resolveFeeTiers`, `loadTiers`),
`pricing/fee-policy-resolver.service.ts`, `pricing/fee-schedule-fingerprint.ts`,
`bookings/orchestration/booking-execution-router.service.ts`,
`bookings/orchestration/local-booking-orchestrator.service.ts`,
`payments/payments.service.ts` (`createIntent`, `processVerifiedEvent`, `confirm`),
`packages/shared-types/src/marketplace.ts` (`routeProviderForBooking`, `CURRENCY_PROVIDERS`),
`payments/razorpay/razorpay-order.service.ts`, `payments/orchestration/payment-orchestrator.service.ts`,
`payments/configuration/payment-routing.ts`, `payments/razorpay/razorpay-webhook.controller.ts`,
`payments/webhooks/stripe/stripe-webhook.controller.ts`,
`payments/recovery/pending-payment-recovery.service.ts`, `apps/worker/src/main.ts`.

Notes:

- The fee-schedule fingerprint is checked at booking time but not stored on `Booking`. The
  booking stores the fee amounts and the applied policy (`feePolicyId`, `feePolicyKind`,
  `feePolicyVersion`, `baseBookingFeeMinor`, `feeWaivedMinor`).
- Free and cash bookings create no `Payment` row.
- Unverified: the exact channel set for `BOOKING_CONFIRMED` per market. The policy is in
  `notifications/policy/`.

## 2. Refund and the organizer settlement share (R1)

```mermaid
sequenceDiagram
  autonumber
  actor C as Buyer or organizer
  actor A as Organizer owner or admin
  participant API as api
  participant PG as PostgreSQL
  participant P as Razorpay or Stripe
  participant WK as worker

  C->>API: POST /refunds (or guest link, or show cancellation)
  API->>PG: Refund REQUESTED
  A->>API: POST /refunds/:id/process (approve)
  API->>PG: guarded claim REQUESTED to PROCESSING
  API->>PG: RefundProviderAttempt with a stable idempotency key (before the call)
  API->>P: refund
  P-->>API: accepted or completed
  API->>PG: one transaction - tickets REFUNDED, booking and payment status,<br/>Refund COMPLETED or PROCESSING, credit note, Notification, audit
  P->>API: refund webhook (Razorpay refund.processed, Stripe refund event)
  API->>PG: Refund COMPLETED, Payment refundedMinor capped at the captured amount
  API->>API: organizerShareOfProviderRefund (R1)
  API->>PG: Settlement.refundsMinor += organizer share
  opt settlement already transferred
    API->>PG: SettlementReversalAttempt REQUESTED
    API->>P: reverse transfer
    API->>PG: COMPLETED, PROCESSING, FAILED or UNKNOWN
    WK->>PG: reversal-reconcile settles PROCESSING and UNKNOWN
  end
```

**R1 rule.** The organizer's share of a refund is
`max(0, amountMinor - taxAddedMinor - platformFeeRefundedMinor)` when the platform's own
COMPLETED refund rows explain the provider amount exactly. Otherwise (for example a refund made
in the provider dashboard) the share is pro rata: `delta x organizerNetMinor / amountMinor`.
Settlements written before the fix are not recomputed. Payout allocations use the same function:
a refund after a payout becomes a new negative (clawback) `PayoutAllocation`.

Files: `refunds/refunds.service.ts` (`request`, `process`, `payClaimed`),
`refunds/refund-provider-call.ts`, `payments/razorpay/razorpay-webhook.processor.ts`
(`handleRefund`), `payments/webhooks/stripe/stripe-webhook.processor.ts`,
`payments/settlement/refund-organizer-share.ts`, `payouts/currency-settlement.calculator.ts`
(`organizerShareOfRefund`), `payments/settlement/settlement.service.ts` (`applyRefund`,
`reverseIfTransferred`), `payouts/payout-allocation.ts`,
`payments/settlement/refund-organizer-share.integration-postgres.spec.ts` (the R1 test).

## 3. Fee schedule draft, validate, publish

```mermaid
sequenceDiagram
  autonumber
  actor A as Admin (PLATFORM_CONFIG)
  participant AW as admin-web
  participant API as api
  participant PG as PostgreSQL

  A->>AW: open fee schedule for a currency
  AW->>API: POST /admin/fee-schedules/drafts
  API->>PG: reuse the OPEN draft, or copy live FeeRule bands<br/>and store baseFingerprint
  API->>PG: audit FEE_SCHEDULE_DRAFT_CREATED
  loop edit
    AW->>API: PUT /admin/fee-schedules/drafts/:id (whole band list)
    API->>PG: save bands, audit FEE_SCHEDULE_DRAFT_SAVED with the diff
    API-->>AW: validation issues, preview, stale flag
  end
  A->>AW: publish
  AW->>API: POST /admin/fee-schedules/drafts/:id/publish
  API->>API: RequiresRecentMfa (step-up)
  API->>PG: transaction - advisory lock per currency
  API->>API: draft still OPEN, live fingerprint equals baseFingerprint,<br/>validateSchedule passes (no overlap, no gap, right market)
  alt any check fails
    API-->>AW: 409 DRAFT_CLOSED, FEE_SCHEDULE_STALE or FEE_SCHEDULE_INVALID
  else all pass
    API->>PG: version = max published + 1, apply bands to FeeRule<br/>(update, create, soft-delete), draft PUBLISHED
    API->>PG: audit FEE_SCHEDULE_PUBLISHED in the same transaction
    API-->>AW: published version
  end
  Note over API,PG: the next quote reads the new bands. A booking created with the<br/>old fingerprint gets 409 FEE_SCHEDULE_CHANGED.
```

There is no maker-checker on publish: one admin with `PLATFORM_CONFIG` and a recent MFA step-up
can publish. The old per-band endpoints in `admin/admin.controller.ts` return 410 Gone.
`PlatformFeePolicy` is a separate per-event or per-organization override (`WAIVE`, `FIXED`,
`PERCENT`, `COMBINED`, with a time window and an optional order cap), managed at
`/admin/platform-fee-policies`. It wins over the schedule.

Files: `admin/fee-schedules.controller.ts`, `admin/fee-schedules.service.ts`,
`admin/fee-schedule-validation.ts`, `pricing/pricing.service.ts`,
`pricing/fee-policy-resolver.service.ts`,
`apps/api/prisma/migrations/20261030100000_fee_schedule_drafts/migration.sql`.

## 4. Organizer subscription checkout, billing webhooks and dunning

```mermaid
sequenceDiagram
  autonumber
  actor O as Organizer owner
  participant OW as organizer-web
  participant API as api
  participant PG as PostgreSQL
  participant BP as Stripe Billing (US) or Razorpay Subscriptions (IN)
  participant WK as worker

  O->>OW: choose a plan
  OW->>API: POST /organizations/:id/billing/checkout
  API->>API: assertEnabled - BILLING_ENABLED, live market open, provider configured
  API->>PG: billing account (provider fixed for life), active price for the country
  API->>API: tax quote (no tax rule means no checkout)
  API->>BP: create checkout with the price reference
  API-->>OW: checkout URL (nothing is activated yet)
  O->>BP: pays
  BP->>API: POST /billing/webhooks/stripe or /billing/webhooks/razorpay
  API->>API: verify signature on the raw body (400 if invalid)
  API->>PG: BillingWebhookEvent unique (provider, providerEventId)
  API->>BP: re-fetch payment record and subscription
  API->>API: check paid, purpose, price, country, currency, amount, customer
  API->>PG: under the account lock - transition ACTIVATE, RENEW or CHANGE_PLAN_NOW<br/>with verified PaymentEvidence, audit
  API-->>BP: 200
  loop billing-sweep every 15 minutes
    WK->>PG: clock events (trial, grace, complimentary, period end)
    WK->>BP: recover a missed renewal before marking PAST_DUE
    WK->>PG: ACTIVE to PAST_DUE, after BILLING_PAST_DUE_DAYS PAST_DUE to GRACE
    WK->>O: dunning email per stage (PAST_DUE, GRACE, GRACE_ENDING), once each
    WK->>PG: retry pending BillingWebhookEvent rows
  end
  Note over WK,BP: billing-price-check (daily) compares catalogue prices with Stripe<br/>prices by lookup key and only reports.
```

Billing is off in production (`BILLING_ENABLED` unset). The boot gate is described in
[ARCHITECTURE](ARCHITECTURE.md#56-configuration-gates-fail-closed-at-boot). Provider by market:
`US` to Stripe Billing, `IN` to Razorpay Subscriptions, with no fallback between them. Feature
access goes through `@RequiresEntitlement(key)` and `EntitlementService`. Billing provider
setup is described in [docs/billing/BILLING-PROVIDERS.md](../billing/BILLING-PROVIDERS.md).
Unverified: the exact state mapping inside `reconcile()` for status-only provider events.

Files: `billing/billing.controller.ts`, `billing/billing-checkout.service.ts`,
`billing/provider/billing-provider.registry.ts`, `billing/provider/stripe-billing.provider.ts`,
`billing/provider/razorpay-subscriptions.provider.ts`, `billing/billing-webhook.controller.ts`,
`billing/billing-provider-events.service.ts`, `billing/subscription.service.ts`,
`billing/subscription-state-machine.ts`, `billing/billing-sweep.service.ts`,
`billing/billing-dunning.ts`, `billing/billing-price-reconcile.service.ts`,
`billing/entitlements/requires-entitlement.ts`, `config/configuration.ts`
(`billingConfigurationErrors`).

## 5. Phone OTP through MSG91 with delivery-report correlation

```mermaid
sequenceDiagram
  autonumber
  actor U as User
  participant C as web or mobile
  participant API as api
  participant R as Redis
  participant PG as PostgreSQL
  participant M as MSG91 (India) or Twilio (US, CA)

  U->>C: enter phone number
  C->>API: POST /auth/phone/request-code (throttled, human check)
  API->>API: SMS_ENABLED, normalise number, allowed destination market
  API->>R: OtpSmsGuard.reserve - per-number day and hour caps, resend cooldown,<br/>platform and per-market daily budgets (atomic Lua)
  Note over API,PG: if Redis is down - advisory lock and row counts in PostgreSQL
  API->>PG: consume older live codes, create PhoneOtp (bcrypt hash, expiry)
  API->>API: route by SMS_PROVIDER_BY_MARKET, pick the DLT template
  API->>M: send (MSG91 flow API with DLT template and sender header)
  M-->>API: request id
  API->>PG: PhoneOtp provider, providerMessageId = request id, ACCEPTED
  API-->>C: code sent
  M->>API: delivery report POST /notifications/webhooks/msg91/:secret
  API->>PG: ledger row unique (provider, eventId) - duplicate is a no-op
  API->>PG: match NotificationDelivery by providerMessageId, else PhoneOtp
  alt no match yet
    API->>PG: AWAITING_CORRELATION (replayed by notification-callback-replay)
  end
  U->>C: enter code
  C->>API: POST /auth/phone/verify
  API->>PG: claim an attempt (at most 5), bcrypt compare, consume
  API->>PG: find or create User
  API-->>C: access and refresh tokens (MFA challenge for staff accounts)
```

The OTP goes straight to the SMS channel and never becomes a `Notification` row, so no stored
row holds the code. The MSG91 callback has no provider signature. A secret path segment
authenticates it (configured in `MSG91_WEBHOOK_SECRET`, never documented with its value).

Files: `auth/auth.controller.ts`, `auth/phone-otp.service.ts`, `auth/otp-destination.ts`,
`auth/otp-sms-guard.ts`, `auth/phone-otp-delivery.sink.ts`,
`notifications/channels/sms.channel.ts`, `notifications/channels/notification-provider.resolver.ts`,
`notifications/channels/transports/sms.transport.ts`, `notifications/templates/dlt-sms-templates.ts`,
`notifications/delivery/webhook/delivery-webhook.controller.ts`,
`notifications/delivery/webhook/delivery-webhook.service.ts`,
`notifications/delivery/webhook/delivery-webhook.parsers.ts`,
`notifications/delivery/delivery-recorder.service.ts`,
`notifications/delivery/webhook/provider-event-replay.service.ts`.

## 6. Transactional email and SMS with suppression

```mermaid
sequenceDiagram
  autonumber
  participant D as Domain service (payments, refunds, shows, support)
  participant NS as NotificationService
  participant PG as PostgreSQL
  participant WK as worker dispatch-notifications
  participant SES as Amazon SES
  participant SMS as MSG91 or Twilio
  participant SNS as Amazon SNS
  participant WH as api delivery webhook

  D->>NS: send or sendCritical(tx, type, recipient)
  NS->>NS: policy - channels from consent and SMS_TRANSACTIONAL_TYPES and _MARKETS
  NS->>PG: Notification rows PENDING (in the caller's transaction for critical sends)
  loop every 5 seconds
    WK->>PG: due PENDING or SCHEDULED rows
    WK->>PG: SuppressedDestination check (hashed destination)
    alt suppressed
      WK->>PG: delivery not attempted (POLICY_SUPPRESSED), Notification SKIPPED
    else allowed
      WK->>PG: open NotificationDelivery attempt
      alt email
        WK->>SES: SendEmail with the configuration set
      else SMS
        WK->>SMS: send with the DLT template (India) or Twilio (US, CA)
      end
      WK->>PG: accepted, logged, skipped or failed (with retry delay)
    end
  end
  SES->>SNS: delivery, bounce, complaint events
  SNS->>WH: POST /notifications/webhooks/ses/:secret
  Note over SNS,WH: path secret, then SNS signature and certificate URL check.<br/>Subscription confirmations are accepted only for SES_SNS_TOPIC_ARNS.
  WH->>PG: ledger, then NotificationDelivery status
  WH->>PG: bounce or complaint adds SuppressedDestination
```

The worker's `notification-fallbacks` job opens a paid fallback channel when the free channels
produced nothing useful after the policy's wait. `notification-callback-replay` re-applies
events that arrived before their delivery row.

Files: `notifications/notification.service.ts` (`send`, `sendCritical`, `fanOutCritical`,
`schedule`, `dispatchDue`, `sweepDue`), `notifications/policy/notification-policy.resolver.ts`,
`notifications/policy/sms-transactional.ts`, `notifications/delivery/suppression.service.ts`,
`notifications/channels/transports/email.transport.ts` (`SesEmailTransport`),
`notifications/delivery/webhook/sns-verifier.ts`,
`notifications/delivery/webhook/sns-confirmation.service.ts`,
`notifications/delivery/webhook/sns-body.middleware.ts`, `notifications/policy/fallback.service.ts`,
`apps/worker/src/main.ts`.

## 7. Marketing campaign send guard

```mermaid
sequenceDiagram
  autonumber
  actor O as Organizer
  participant API as api
  participant PG as PostgreSQL
  participant Q as Redis campaigns queue
  participant WK as worker campaign jobs
  participant SES as Amazon SES (marketing configuration set)

  O->>API: create, schedule or send a campaign
  API->>API: campaignSendingConfig - CAMPAIGNS_ENABLED, marketing sender and<br/>configuration set, unsubscribe signing secret (staging and production)
  API->>API: assertMember and EntitlementService (CAMPAIGNS_CREATE, CAMPAIGNS_SCHEDULE)
  API->>PG: Campaign SCHEDULED or QUEUED
  loop campaign-tick
    WK->>PG: promote due campaigns
    WK->>Q: campaign-expand (one per campaign)
    WK->>PG: expand audience into CampaignRecipient rows
    WK->>Q: campaign-send per recipient (rate limited, 4 attempts)
  end
  WK->>PG: sendOne checks in order - campaign SENDING and recipient QUEUED,<br/>quiet hours, earlier in-flight attempt, user ACTIVE,<br/>CommunicationConsent for the purpose, OrganizerSuppression,<br/>global SuppressedDestination, footer postal address, quota
  alt a check fails
    WK->>PG: SKIPPED_CONSENT, SKIPPED_SUPPRESSED, or pause the campaign<br/>(POSTAL_ADDRESS_MISSING, QUOTA_EXHAUSTED)
  else all pass
    WK->>PG: atomic claim of the recipient
    WK->>SES: send with List-Unsubscribe and one-click headers
    WK->>PG: consume entitlement quota
  end
```

Campaigns are off in production (`CAMPAIGNS_ENABLED` unset). `PENDING_APPROVAL` exists in the
campaign state table, but no route uses it yet. Admin staff can stop a campaign through
`/admin/campaigns` (needs `ORGANIZER_REVIEW`). Unsubscribe pages are `GET` and
`POST /public/unsubscribe/:token`. The send email transport is the log transport unless
`EMAIL_PROVIDER=ses`.

Files: `campaigns/campaign-sending-config.ts`, `campaigns/campaigns.service.ts`,
`campaigns/campaigns.controller.ts`, `campaigns/campaign-state.ts`,
`campaigns/campaign-dispatch.service.ts` (`tick`, `expand`, `sendOne`),
`campaigns/quiet-hours.ts`, `campaigns/campaign-transport.ts`, `engagement/unsubscribe-token.ts`,
`engagement/engagement.controller.ts`, `apps/worker/src/main.ts`.

## 8. Payout onboarding and the transfer gate

```mermaid
sequenceDiagram
  autonumber
  actor O as Organizer owner or manager
  actor F as Finance admin
  participant API as api
  participant PG as PostgreSQL
  participant PP as Stripe Connect or Razorpay Route
  participant WK as worker

  alt US organizer
    O->>API: POST /organizers/:id/payments/stripe/account, then onboarding-link
    API->>PP: create Express account and onboarding link
    PP->>API: account updates (charges and payouts enabled)
  else India organizer
    O->>API: POST Razorpay Route linked account
    API->>PP: create route_linked account
  end
  O->>API: save bank details
  API->>PG: OrganizerPayoutAccount (AES-256-GCM cipher, last 4) and a masked version
  F->>API: verify bank details (PAYOUT_MANAGE and BANK_VERIFY, not the maker, not a member)
  API->>PG: version VERIFIED
  WK->>PG: payout-runs hourly - SCHEDULED Payout ledger rows where autoGenerate is on
  F->>API: approve settlement (PAYOUT_MANAGE, PAYOUT_EXECUTE, recent MFA)
  API->>PG: Settlement ELIGIBLE to APPROVED
  F->>API: release settlement (same permissions, recent MFA)
  API->>API: PAYOUT_EXECUTION_ENABLED must be true (default off)
  alt gate closed
    API-->>F: 409, settlement unchanged
  else gate open
    API->>PG: no PENDING, SCHEDULED or PAID Payout already covers the event
    API->>PG: guarded claim APPROVED or FAILED to TRANSFER_PROCESSING
    API->>API: Razorpay needs RAZORPAY_ROUTE_ENABLED and a linked account, else BLOCKED
    API->>API: earlier UNKNOWN attempt without idempotent transfers, else BLOCKED
    API->>API: recompute payable (refunds, disputes, earlier transfers, reserve)
    API->>PG: SettlementTransferAttempt REQUESTED (key settlement_id_amount)
    API->>PP: transfer (outside any transaction)
    API->>PG: TRANSFERRED, FAILED, or UNKNOWN for reconciliation
  end
```

Provider transfers are off in production (`PAYOUT_EXECUTION_ENABLED` unset). The standing rule
is that they stay off until the post-transfer checks are proven. `payout-runs` only writes
ledger rows and never moves money.

Files: `payments/connect/organizer-connect.controller.ts`,
`payments/razorpay/razorpay-connect.controller.ts`, `payments/razorpay/razorpay-connect.service.ts`,
`payouts/payout-accounts.service.ts`, `payments/settlement/settlement.controller.ts`,
`payments/settlement/settlement.service.ts` (`release`, `payoutExecutionEnabled`),
`payments/settlement/transfer-reconciliation.service.ts`, `payouts/payout-run.service.ts`,
`apps/api/prisma/schema.prisma` (`OrganizerPayoutAccount`, `SettlementTransferAttempt`).
