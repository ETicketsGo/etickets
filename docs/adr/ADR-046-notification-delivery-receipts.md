# ADR-046: Delivery receipts, suppression, and what we can honestly claim

- **Status:** Accepted
- **Date:** 2026-09-07
- **Extends:** [ADR-045](./ADR-045-notification-provider-routing.md)
- **Scope:** Provider-neutral notification platform, Phase 2

## Context

Phase 1 made sending safe, truthful and market-aware. It left one thing untrue by omission:
`Notification.status` went to `SENT` the moment a provider returned a message id, and a
provider returning a message id means it has queued something. It does not mean anybody
received anything.

So a hard bounce ten seconds later changed nothing. The row still said SENT. The customer who
never got their ticket left no trace, and the only way to investigate was a psql prompt — where
the answer would have been wrong anyway.

## Decision

### 1. Acceptance and delivery are different facts

`ACCEPTED` means the provider took it. `DELIVERED` means the provider says it arrived. Nothing
moves a message between them except the provider telling us, through a callback we verified.

The full lifecycle: `PENDING → ATTEMPTING → ACCEPTED → DELIVERED → READ`, with terminal
outcomes `UNDELIVERED`, `FAILED`, `REJECTED`, `COMPLAINED`, `BOUNCED`.

### 2. `NotificationDelivery` — a new table, and why

Phase 1 deliberately put `provider` and `providerMessageId` on `Notification` and went no
further. Receipts changed the shape of the problem in two ways.

A notification is **retried**, and each attempt gets its own provider message id. A webhook
arriving forty seconds later correlates on that id, so one column loses the first attempt's
identity the moment a second is made — and a late callback about attempt one would either be
dropped or, worse, applied to attempt two.

And the states **diverge**. The intent can be SENT while the attempt that carried it BOUNCED.
One column can only ever hold the more recent of the two.

Nothing is duplicated: recipient, payload, template, locale, tenant and booking all stay on
`Notification` and are reached through `notificationId`. Copying any of them would create a
second place for a customer's email address to be wrong.

### 3. Out-of-order callbacks resolve by rank, not by a transition table

Twilio's `sent` and `delivered` are two HTTP requests racing across the internet. WhatsApp
routinely reports `read` before `delivered`. A transition table would have to enumerate every
out-of-order pair and would still be wrong for the pair nobody thought of.

A rank makes the rule one sentence: **a delivery never goes backwards.** Terminal failures
outrank delivery, because "delivered to the receiving server" and "the mailbox rejected it" are
different hops, and the bounce is the one that must stop future sends.

### 4. `SuppressedDestination` — separate from consent, deliberately

`MarketingConsent` answers "may we send this person promotional material", and its absence
must never withhold a ticket. Suppression answers "does this destination work at all", and it
**must** stop transactional mail too — continuing to email an address that hard-bounces is
what gets a sending domain throttled.

Answering one with the other breaks the platform in both directions: a ticket withheld because
somebody unsubscribed from a newsletter, or a dead mailbox emailed forever because nobody ever
unsubscribed it.

Per channel — a dead mailbox says nothing about a phone. Destinations are stored as SHA-256 of
the normalized value: the only operation is a lookup, a hash answers it exactly as well, and
the alternative is a table of real verified contact details whose entire purpose is to be read
on every send.

**Only permanence suppresses.** `BOUNCED`, `COMPLAINED` and `REJECTED`. Never `UNDELIVERED` or
`FAILED` — a handset that was switched off is a handset that will be switched on again, and
suppressing on that would quietly stop somebody's tickets because their phone was in a tunnel.

### 5. Retry is not resend

Two different things, and conflating them costs money.

A **send attempt** that `FAILED` never reached the provider. Nobody received anything and
nobody was charged, so the worker retries it, governed by the existing attempt counter.

A delivery that came back `UNDELIVERED` was `ACCEPTED` first. The provider took it, charged for
it, and tried. Sending it again is a second message and a second charge on a guess — and the
carrier may yet deliver the first, so the customer gets their ticket twice at our expense.
**Nothing that was once accepted is ever resent automatically.** An operator can, deliberately,
through an audited admin path that refuses a suppressed destination outright and requires
`force` for something already delivered.

### 6. Delivery idempotency — what is and is not guaranteed

This is the part that must not be overstated.

| Layer                          | Guarantee                  | Why                                                                                            |
| ------------------------------ | -------------------------- | ---------------------------------------------------------------------------------------------- |
| Notification intent creation   | **Exactly once**           | The unique index on `dedupeKey`, in the database, true across processes and deploys (Phase 1). |
| Worker execution of a send     | **At least once**          | A leased row and a retry loop. A worker that dies mid-batch has its work redone.               |
| Provider receiving the message | **At least once, at best** | See below.                                                                                     |
| Webhook event application      | **Exactly once**           | The unique index on `(provider, providerEventId)`.                                             |

**There is no exactly-once provider send, and this platform does not claim one.**

A send has three steps that are not atomic: write down that we are about to send, call the
provider, write down what it said. A process that dies between the second and third leaves a
message the provider has accepted and charged for, and a database with no record of it. The
next sweep sends again.

That window cannot be closed from this side, because **none of the providers in the launch
matrix accepts an idempotency key on a send**:

| Provider            | Send idempotency   | Consequence                                  |
| ------------------- | ------------------ | -------------------------------------------- |
| Twilio SMS          | None on `Messages` | A retry is a second SMS and a second charge. |
| MSG91 SMS/WhatsApp  | None documented    | Same.                                        |
| Meta WhatsApp Cloud | None               | Same.                                        |
| SES                 | None               | A retry is a second email.                   |

What is done instead is to make the ambiguity **visible rather than silent**: the attempt row
is written as `ATTEMPTING` _before_ the provider call. A crash leaves an `ATTEMPTING` row that
says, truthfully, "we do not know whether this went out" — which is a thing an operator can
look at, unlike no row at all.

If any of these providers later offers an idempotency key, `DeliveryRecorderService.open`
already produces the stable per-attempt identity to use as one.

### 7. Webhook ingestion reuses `WebhookEvent`

The payments side already solved durable, replay-safe ingestion: a row keyed on
`(provider, providerEventId)` with the unique index as the guarantee. A second parallel table
would mean two places to look when an event goes missing. Notification events use the same
table under a `notification:` provider prefix.

**Every path returns 2xx except an invalid signature.** A provider that gets a 5xx redelivers
for hours, so an event that is genuinely unusable — a message id from another environment, an
unmapped status, a body that will never parse — is recorded, counted and acknowledged. An
invalid signature is refused with 401 and writes nothing, because these endpoints can suppress
a destination and an unverified one is a way to stop somebody receiving their tickets.

### 8. SES events over SNS, and an honest limitation

SES publishes delivery, bounce and complaint events through SNS. The application-side receiver
and normalizer are implemented; the SNS topic, subscription and SES configuration set are
external setup and are documented, not faked.

**The SNS cryptographic signature is not verified.** SNS signs with RSA-SHA1 over a canonical
string using a certificate fetched from a URL inside the message — which requires an outbound
fetch, a strict check that the certificate's host is genuinely an AWS signing host (the check
people forget, and the one whose omission makes the whole scheme worthless), and a cache. That
is a real piece of work with a real footgun, and half-building it would be worse than not
building it.

The endpoint is instead protected by a high-entropy secret in the callback path, which AWS
supports because the subscription endpoint is configured once. The topic can additionally be
locked to this endpoint by subscription policy. This is weaker than a signature and is recorded
as weaker. MSG91 is the same, for the same reason: they publish no signing scheme at all.

Subscription confirmations are **not** auto-confirmed — an endpoint that confirms whatever is
offered will attach itself to any topic anyone points at it.

## Consequences

- "Did the customer get it?" is answerable, by a support desk, without database access.
- A hard bounce or a complaint stops future traffic to that address on that channel, and only
  that channel.
- An operator can see per-provider failure rates, which is what turns "messages stopped" into
  "MSG91 stopped".
- Push has no delivery receipt and cannot have one: FCM offers no per-message callback (only a
  BigQuery export) and Web Push offers only an HTTP status. Push stops at `ACCEPTED`, honestly.
- Expo has a _pull_ receipts API rather than a webhook. Not built; documented.
- SendGrid's event webhook is not implemented — the launch matrix uses SES, and SendGrid's
  signed-event verification needs an EC public key that no environment has. The status mapping
  exists so it is a small piece of work when wanted.
- Two new tables. No cost ledger, no analytics dashboard, no template UI, no campaign engine.
