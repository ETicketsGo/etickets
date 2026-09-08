# ADR-045: Market-aware notification provider routing

- **Status:** Accepted
- **Date:** 2026-09-06
- **Supersedes:** the provider note in ADR-020 (not ADR-020 itself)
- **Scope:** Provider-neutral notification platform, Phase 1

## Context

ADR-020 established the notification platform: a `NotificationChannel` seam with a registry,
a template service, per-user preferences, and a scheduled/retryable lifecycle. It closed by
saying "providers remain unimplemented (log-only) — binding SendGrid/Twilio/FCM is a later,
isolated change."

That change happened. Real adapters exist for SES, SendGrid, Twilio, Meta's WhatsApp Cloud
API, FCM, Expo and self-hosted VAPID. A Phase 0 audit (`docs/notifications/PHASE-0-AUDIT.md`)
found that the architecture was sound and the ADR's provider note was simply out of date.

It also found three defects, one architectural and two operational.

**Provider selection was per-process.** Each channel bound exactly one transport, built once
at module construction from one environment variable. That is a per-process answer to a
per-message question. "India goes to MSG91, the United States and Canada go to Twilio" could
not be expressed at all — not because anyone had decided against it, but because there was
nowhere to put it. India is not optional here: an Indian operator will not deliver a
transactional message that was not sent under a DLT-registered sender against an approved
template, and Twilio's price into India is not one to pay for ticket volume.

**Delivery was not isolated from the business transaction.** `send()` delivered inline,
unguarded, in the caller's request. Sixteen services call it, and two call it immediately
after money has moved. A provider timeout would have unwound through a path whose work had
already committed. It has never happened only because the configured provider has always been
`log`, which cannot fail.

**The status column was not true.** Rows were written `SENT` before delivery was attempted.

## Decision

### Routing

A `NotificationProviderResolver` chooses the transport per message, modelled directly on
`PaymentProviderResolver` — which already runs Stripe and Razorpay simultaneously in this
process. Adapters are constructed lazily on first use and cached, so boot never needs every
vendor's credentials; a selected provider with missing keys throws at construction rather than
falling back silently.

The routing decision itself is a pure function in `@eticketsgo/shared-types`
(`routeNotificationProvider`), alongside `routeProviderForBooking`, so it is testable without
a container and cannot drift into call sites.

**The market comes from the destination, not from a profile field.** For SMS and WhatsApp the
market that matters is the one being delivered into, and the E.164 number is that fact. A
sender may pass a `country` it knows from trusted business data and that wins; otherwise the
number decides. A venue's country is deliberately NOT used: an Indian buyer at a US venue has
an Indian number, and routing them to Twilio would be wrong.

**An unroutable destination is refused, not defaulted.** Once a market table is configured the
platform is multi-market, and a destination it cannot attribute is exactly where sending
anyway is a mistake — through the wrong provider the message is either dropped by the carrier
or billed at an international rate, and neither is visible until a customer says their ticket
never arrived. The notification is marked FAILED with the reason on it.

Launch matrix (`SMS_PROVIDER_BY_MARKET`, `WHATSAPP_PROVIDER_BY_MARKET`):

| Channel  | India                                                 | United States | Canada     |
| -------- | ----------------------------------------------------- | ------------- | ---------- |
| Email    | SES                                                   | SES           | SES        |
| SMS      | MSG91                                                 | Twilio        | Twilio     |
| WhatsApp | MSG91                                                 | Meta Cloud    | Meta Cloud |
| Push     | Expo / FCM (the device's token names its own service) |

Email and push keep one transport per process: SES serves every market, and a push token
names its own delivery service. Adding market routing there would be machinery with no
decision behind it.

Twilio WhatsApp is deliberately not implemented. The Meta Cloud adapter already works in every
market with no business solution provider in between, and a working integration is worth more
than a uniform one. Adding a BSP later is one `buildWhatsAppTransport` case and one map entry.

### Delivery isolation

`send()` writes rows and returns. It performs no provider I/O. The worker's existing sweep —
which already retried, already had somewhere to record a failure, and previously carried only
deferred reminders — now carries everything, and its interval drops from 30s to 5s because it
is on the path of a ticket somebody just paid for.

The `Notification` table is the durable queue. It already had `status`, `attempts`,
`lastError`, `scheduledFor` and a worker dispatcher. Routing notifications through the
domain-event outbox on the way to this same table would add a second durable store for the
same fact, no additional guarantee, and a dependency on `DOMAIN_EVENTS_ENABLED`, which is off
by default — meaning every notification on the platform would stop. `send()` also accepts an
optional transaction client, so a caller that wants the atomic guarantee gets it by writing
the notification in the same transaction as the business change.

### Truthful status

No new states. `PENDING` already existed in the schema and was unreachable; it now means what
it says. PENDING/SCHEDULED → provider accepts → SENT, with `provider` and `providerMessageId`
recorded. A skip (no phone on file, no registered device) is SENT with the reason in
`lastError` — nothing was delivered because there was nowhere to deliver to, and retrying
cannot change that. A permanent refusal goes straight to FAILED without burning retries.

### Channel policy

Fixing the SMS recipient bug without this would have been the most expensive one-line change
in the platform's history: every type shared one default channel list, so the moment SMS could
reach a phone, every notification would have started sending one. `CHANNEL_POLICY` is an
allowlist per message type. A caller may ask for fewer channels than policy permits, never
more.

### Duplicate suppression

`Notification.dedupeKey`, unique, nullable. The index is the entire mechanism — every cause of
a duplicate outlives a process. It is opt-in per type: a type earns a key only by naming the
payload fields that identify its subject. Types that may legitimately repeat (reminders,
password resets) carry a null key, and Postgres permits any number of nulls in a unique index.

## Consequences

- A notification provider outage can no longer fail a payment, refund or booking.
- Notification delivery is up to ~5s later than before. That is the cost of not doing provider
  I/O in a request that has already taken money.
- Two SMS providers and two WhatsApp providers can run in one process.
- MSG91 cannot send anything until an account, a DLT-registered sender and approved templates
  exist. That is reported as EXTERNAL SETUP REQUIRED and is not faked in tests.
- `Notification` gains three nullable columns. No new tables.
- Delivery receipts, bounce/complaint suppression, cost ledger and an admin delivery dashboard
  are explicitly deferred.

---

## Addendum (Phase 1 follow-up)

### Critical notifications commit with the domain change

Making `send()` a durable enqueue removed the provider from the payment path. It left the
enqueue _after_ the commit, and therefore a crash window: booking confirmed, money taken,
process dies, and the confirmation carrying somebody's ticket was never recorded — so nothing
retried it, because nothing knew it was owed. Rare, permanent, and on the most important
message the platform sends.

`sendCritical(tx, input)` takes the transaction client as its **first, required** argument, so
it cannot be omitted the way an optional trailing parameter can. `fanOutCritical(tx, …)` does
the same for one fact reaching many people, in a single statement. Five types are classified
critical: `BOOKING_CONFIRMED`, `BOOKING_CANCELLED`, `REFUND_COMPLETED`, `SETTLEMENT_RELEASED`,
`SHOW_CHANGED`. Enforcement is three-layered: a required argument, a runtime error log if a
critical type reaches `send()` without a transaction (which still writes the row — never lose
the message), and a source-scanning test that fails the build if a producer uses the wrong
method.

`SettlementService.release` had no surrounding transaction at all. The provider transfer has
already happened by then and cannot be inside a database transaction; what is now wrapped is
the platform's own record of the release and the notice about it, which is the pair that must
not come apart.

### A unique violation must never reach the transaction

The atomicity test found a defect introduced by the dedupe key itself. The insert caught
`P2002` in JavaScript — but catching a constraint violation does not un-abort a PostgreSQL
transaction. Once the statement fails the transaction is poisoned and the commit becomes a
rollback. A redelivered webhook whose notification had already been written would therefore
have **silently discarded the booking confirmation, the tickets and the receipt written
alongside it**, and reported success. Idempotency would have destroyed committed work.

Dedupable inserts now go through `createMany({ skipDuplicates: true })` — `ON CONFLICT DO
NOTHING`, which never raises. Rows with no dedupe key keep a plain `create`, which cannot
conflict and returns the id `schedule()` needs.

### SHOW_CHANGED

A material reschedule — the start time moved — notifies every booking still live on that
session (`CONFIRMED` or `PARTIALLY_REFUNDED`), inside the reschedule transaction, so nobody is
told about a change that rolled back and no committed change goes untold. `endsAt` is derived
from the film's runtime and is never material on its own. Email, in-app, push and WhatsApp; no
SMS, which stays reserved for `BOOKING_CANCELLED`. The dedupe subject is the booking **and the
new start time**, so a show moved twice is two pieces of news and only the second is true.
