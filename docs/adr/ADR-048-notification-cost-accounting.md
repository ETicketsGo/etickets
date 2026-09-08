# ADR-048: Notification cost accounting, and what we can honestly total

- **Status:** Accepted
- **Date:** 2026-09-08
- **Extends:** [ADR-045](./ADR-045-notification-provider-routing.md), [ADR-046](./ADR-046-notification-delivery-receipts.md), [ADR-047](./ADR-047-notification-policy-and-fallback.md)
- **Scope:** Provider-neutral notification platform, Phase 4

## Two corrections first

### The emergency was attached to the wrong fact

`BOOKING_CANCELLED` carried the SMS fallback, and it had **no producer anywhere** — the
mapping was documentation, not behaviour. That mattered, because "a booking was cancelled"
includes a customer cancelling their own booking, from their own account, deliberately. Wiring
that up would have texted them thirty minutes later, at our expense, about a decision they had
just made.

`SHOW_CANCELLED` is now its own type and carries the emergency: SMS eligibility, the 30-minute
fallback, `URGENT`. `BOOKING_CANCELLED` is the ordinary per-booking notice — email, inbox,
push, no SMS, no fallback. The domain fact already existed as `DomainEventType.SessionCancelled`;
this is its notification, not a duplicate event.

### Suppression was ambiguous

Verified: a suppressed destination is never retried (the row goes `FAILED`, and the sweep only
claims `PENDING`/`SCHEDULED`), the provider is never called, and no cost is recorded. But it
was a status flip with a magic string in `lastError`, invisible to any report.

It now writes a delivery row with `outcomeClass: POLICY_SUPPRESSED`, provider `none`, and
`costSource: UNKNOWN` — _not_ `CONFIGURED_FREE`, because nothing was sent, so there is no price
to quote. Provider health filters on `provider != 'none'` and on outcome class, so a
suppression cannot lower anybody's reliability figure.

## Decision

### 1. Money is micros, and integers

SES is **$0.10 per thousand emails** — a hundredth of a cent each. Every other price on this
platform is an integer number of minor units, and in cents that email rounds to zero or to one:
one understates the bill to nothing, the other overstates it a hundredfold.

So notification money is stored in **micros** — millionths of a currency unit. SES is 100
micro-USD, a Twilio segment around 7,900, an MSG91 SMS around 150,000 micro-INR. All integers.
The column is named `costMicro` so it cannot be mistaken for a `feeMinor`. No floating point
appears anywhere: `0.1 + 0.2` is not `0.3`, and these are summed over millions of rows.

### 2. Unknown is not zero

The single most important rule here. "We have no rate for MSG91 WhatsApp in India" and "MSG91
WhatsApp in India is free" produce the same total and mean opposite things — the first says the
number is missing a component, the second says it is complete.

`CostSource` distinguishes `UNKNOWN` from `CONFIGURED_FREE`, and **every report carries an
unknown count beside its total**. Until that count is zero, the total is a floor.

### 3. `NotificationDelivery` is the ledger; no separate cost table

The brief allowed one. It is not needed: an attempt is already immutable in practice, already
one row per provider interaction, and already the thing a provider charges for. A second table
would duplicate the join key and give two places to look for one number.

Reconciliation is still possible: `costSource` moves to `RECONCILED` when an invoice corrects
an estimate, and `costCalculatedAt` records when the figure was last derived. If future
reconciliation needs append-only _adjustments_ rather than corrections, that is when a ledger
earns its place — not before.

Added: `costMicro`, `costCurrency`, `costSource`, `billedUnits`, `costCalculatedAt`,
`sendKind`, `outcomeClass`.

### 4. Rates are effective-dated configuration

`NotificationRate`, modelled on `TaxRule`: `*` wildcards for scope, a priority for specificity,
an `active` flag so a rate is written and reviewed before it applies to money, and
`effectiveFrom`/`effectiveTo`.

A price compiled into the application is a deploy every time a vendor renegotiates and, worse,
silently **reprices history** — last month's report recomputed at today's price. Superseding is
an end date, never a delete, so the period a rate priced stays reproducible.

**Overlapping active rates are refused at write time.** Two of them do not produce a wrong
number, they produce an unstable one: the cost depends on which row the database returned.

**No production prices ship.** Real rates depend on a contract, a volume tier and a destination
operator. A plausible invented number in an accounting table is worse than none, because it
produces a total somebody will believe.

### 5. Billing units, because providers do not agree

`PER_MESSAGE`, `PER_SEGMENT`, `PER_CONVERSATION`, `PER_TEMPLATE_MESSAGE`, `PER_1000`,
`PER_REQUEST`.

**SMS segments are counted, not estimated.** A 200-character message is two segments. The same
message with a rupee sign in it is Unicode, the segment size falls from 160 to 70, and it is
three — which is exactly what an Indian transactional template produces. The GSM-7 alphabet
and its extension table are a published standard, so this is exact rather than approximate,
and `billedUnits` records what was counted.

Email under `PER_1000` divides once at the end rather than rounding every message.

### 6. Cost is recorded at acceptance and never removed

Acceptance is what a provider bills for. A message that is accepted and then comes back
`UNDELIVERED`, or bounces, or earns a complaint, was still carried and still costs the same.
Removing the cost when the outcome turns bad would make the total **shrink as things go
wrong** — the opposite of what an operator needs. Delivery outcome and money are separate
facts, stored separately.

A send that never reached a provider carries no cost: `PROVIDER_UNAVAILABLE`, nothing billed.

### 7. Provider health uses a denominator that is only the provider

`OutcomeClass` splits ours from theirs. `POLICY_SUPPRESSED` and `NO_DESTINATION` are ours and
are excluded; `PROVIDER_ACCEPTED`, `PROVIDER_REJECTED`, `PROVIDER_UNAVAILABLE` and
`UNDELIVERABLE_DESTINATION` are the denominator.

Counting our own decisions as provider failures would make every provider look broken in
proportion to how many of our customers have preferences — and hide a real outage inside a
number that is always high.

**Push reports `deliveryMeasurable: false` rather than a fabricated 0%.** Neither FCM nor Web
Push has a per-message delivery callback.

### 8. Currencies are never added

There is no exchange rate in this codebase and there will not be one. Rupees and dollars come
back as separate rows. Inventing a conversion to produce one comforting number makes the report
wrong at a rate that changes daily, in a direction nobody chose.

### 9. `Notification.bookingId` has no foreign key — deliberately

Cost-per-booking has to join, and `payload->>'bookingId'` is a JSON extraction over every row
of the largest table on the platform. So the id is lifted into an indexed column.

**Without a constraint.** With one, a payload naming a booking that has since been deleted
makes the INSERT fail and the notification is lost — an accounting column stopping a
customer's ticket. `ON DELETE SET NULL` would be worse still: it erases which booking a message
belonged to, taking last quarter's cost-per-booking with it.

### 10. Aggregation is database-side

Every report is `GROUP BY` or a raw aggregate against the declared indexes. A month of
notifications is millions of rows; pulling them into Node to sum them is not slow, it is an
outage. Composite indexes follow the query shapes — `(provider, channel, createdAt)`,
`(outcomeClass, createdAt)`, `(sendKind, createdAt)`, `(type, createdAt)` — rather than one
per column, because no report asks about a provider without also asking about a period.

## Consequences

- Notification spend is answerable by provider, channel, country, event, send kind and booking.
- Fallback SMS and operator resends are separable from ordinary sends — the two questions
  whose answers were otherwise buried in the total.
- Historical rows stay `UNKNOWN`. **No zeros were backfilled**: that would turn "we do not
  know" into "it was free" for every message sent before this phase.
- Nothing can be totalled until rates are configured, and the reports say so.
- Two new columns on `Notification`, seven on `NotificationDelivery`, one new table.
- Not built: invoice ingestion, FX, GL integration, dashboards, price scraping.
