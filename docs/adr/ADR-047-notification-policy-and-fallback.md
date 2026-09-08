# ADR-047: Notification policy, consent, and controlled fallback

- **Status:** Accepted
- **Date:** 2026-09-07
- **Extends:** [ADR-045](./ADR-045-notification-provider-routing.md), [ADR-046](./ADR-046-notification-delivery-receipts.md)
- **Scope:** Provider-neutral notification platform, Phase 3

## Context

Phases 1 and 2 made sending safe, market-aware and observable. The remaining question is a
product one: **the domain should say "this booking was cancelled", never "send an SMS".**

Phase 1's `CHANNEL_POLICY` answered part of it — which channels may a type use — and answered
it well. Three questions sat next to it, answered implicitly or not at all:

- **Which channels may a customer NOT turn off?** Every channel was individually disableable,
  so somebody could quietly configure themselves into a state where a cancelled show reached
  them nowhere. Usually one unchecked box at a time, months apart, with no moment where the
  consequence is visible.
- **When may one channel's silence justify paying for another?** Nothing expressed this, so
  the options were "never" or an uncontrolled "WhatsApp failed, send an SMS" that duplicates
  messages and bills for the privilege.
- **Does a channel need an opt-in even for a transactional message?** WhatsApp business
  messaging rests on the recipient having agreed to be reached there, and there was nowhere to
  say so.

## Decision

### 1. One policy layer, and it never names a provider

```
domain event → POLICY → channel → provider resolver → provider adapter
```

Everything left of `provider resolver` is product: which kinds of message may use which
channels, what a customer asked for, what they consented to. Everything right of it is vendor:
who carries an Indian SMS. `NotificationPolicyResolver` knows no provider names;
`NotificationProviderResolver` knows no message types.

That separation is why adding MSG91 in Phase 1 needed no product decision, and why changing
the channels for a cancellation needs no vendor knowledge.

### 2. `EventPolicy` — four facts, declared together

`channels`, `urgency`, `guaranteed`, `fallback`, `optInRequired`. All properties of the event,
so they live in one declaration rather than four places.

| Type                                         | email | in-app | push | WhatsApp | SMS      | fallback          |
| -------------------------------------------- | ----- | ------ | ---- | -------- | -------- | ----------------- |
| `BOOKING_CONFIRMED`                          | ✅    | ✅     | ✅   | ✅       | —        | none              |
| `BOOKING_CANCELLED` _(= show cancelled)_     | ✅    | ✅     | ✅   | ✅       | deferred | **SMS after 30m** |
| `SHOW_CHANGED`                               | ✅    | ✅     | ✅   | ✅       | —        | none              |
| `REFUND_COMPLETED`                           | ✅    | ✅     | ✅   | ✅       | —        | none              |
| `PAYMENT_FAILED`                             | ✅    | ✅     | ✅   | —        | —        | none              |
| `EVENT_REMINDER` _(= show reminder)_         | —     | ✅     | ✅   | ✅       | —        | none              |
| `SETTLEMENT_RELEASED` _(= organizer payout)_ | ✅    | ✅     | —    | —        | —        | none              |
| anything unlisted                            | ✅    | ✅     | ✅   | —        | —        | none              |

Existing event names, per the Phase 1 mapping. `TICKET_READY` remains folded into
`BOOKING_CONFIRMED`; `REFUND_INITIATED` still does not exist; OTP deliberately bypasses
`NotificationService` so a live credential is never written to a queryable payload, and stays
SMS-only with no WhatsApp fallback.

**SMS is reachable by exactly one type, and never immediately.**

### 3. A preference floor

Preferences exist so people can stop messages they do not want, and almost every type should
be switchable off entirely — a reminder can be reduced to the inbox row and nothing else.

But `guaranteed` channels survive a preference. The floor is the inbox, plus email for
anything about a booking: the record of a transaction goes to the address it was made with.
It is logged when it happens, because somebody who has asked twice deserves a better answer
than silence — but a missing cancellation notice is the worse failure of the two.

### 4. Three questions, kept distinct

| Question                                              | Mechanism                         |
| ----------------------------------------------------- | --------------------------------- |
| May we send this **category** of communication?       | `MarketingConsent`                |
| Which optional **channel** does this person want?     | `NotificationPreference`          |
| Can this **destination** physically receive anything? | `SuppressedDestination` (Phase 2) |

Collapsing any two breaks the platform in a way nobody notices for months. A transactional
message never consults marketing consent — the store is not merely permissive, it is _not
asked_, so a ticket cannot become dependent on a lookup that could fail.

### 5. WhatsApp opt-in reuses the consent table

`MarketingConsent` already records exactly what a WhatsApp opt-in needs: subject, channel,
granted/withdrawn, when, how it was obtained, append-only history. A second table because the
model has "marketing" in its name would give the platform two places to look for one person's
answer and two things to produce for a data-subject request.

What it needed was separation of **meaning**, not storage: the scope
`whatsapp:transactional` means "you may use WhatsApp to tell me about my booking", which is a
different question from `whatsapp`, "you may sell to me there".

**Declared in policy, enforced by configuration.** That WhatsApp rests on prior agreement is a
fact about the channel. Whether this platform requires it is a product and legal decision per
market, so `optInRequired: [whatsapp]` is declared on every WhatsApp-carrying type and
`WHATSAPP_TRANSACTIONAL_OPT_IN_REQUIRED` is **off by default**. Turning it on before the
opt-in has been collected would stop every existing customer's WhatsApp overnight, because
absence of a consent record correctly means no — and applying that retroactively to people who
were never asked is an outage, not compliance.

A missing opt-in removes **that channel**, never the notification.

### 6. Fallback: a wait, a definition of enough, and exactly one

"WhatsApp failed → send an SMS" fires every time WhatsApp is merely slow, sends a second
message about the same thing, and bills for it. On a cancelled sold-out house that is hundreds
of unnecessary SMS arriving after the WhatsApp the customer already read.

So the fallback needs three things:

- **A wait.** 30 minutes, declared per event. Not a guess at network latency — it is how long
  is acceptable for somebody not to know their show is off.
- **A definition of enough.** Any of `satisfiedBy` having got through makes it unnecessary.
- **One, ever.** Created through the ordinary send path with an intent key derived from the
  original, so the Phase 1 unique index makes a second sweep, a restarted worker, or two
  workers racing produce nothing.

**Push ACCEPTED counts as an effective path.** Neither FCM nor Web Push has a per-message
delivery callback, so treating "no push receipt" as "push failed" would fire an SMS at every
customer with the app installed — punishing the channel that works best for being the one that
cannot prove it. WhatsApp and email _do_ report, so acceptance alone is not enough for them.
That is the Phase 2 distinction, applied.

A **post-acceptance** failure never triggers an automatic resend on the same channel (ADR-046);
the fallback opens a _different_ channel, once.

### 7. Anti-bombardment

Each channel is its own row with its own attempt counter and its own dedupe key. So a WhatsApp
timeout re-sends WhatsApp and nothing else — the email and push that already worked are not
recreated. The identity that groups siblings (`intentKey`) is the same identity that separates
them minus the channel, so a fallback can ask "did any preferred channel get through" without
weakening the per-channel dedupe.

### 8. Suppression is per destination, per channel

Checked immediately before the provider call, not at enqueue — a destination can go bad between
a booking on Monday and a reminder on Friday. A suppressed channel is recorded `FAILED` with
`destination_suppressed` and **no provider is called**, so it cannot earn another bounce. The
other channels of the same notification proceed: a dead mailbox says nothing about a phone.

### 9. Phase 2 state-history correction

The review asked whether a `DELIVERED` later `COMPLAINED` preserves the delivery. It does —
`undefined` means "leave it alone" to Prisma. Checking found one place where it was **not**
true: `deliveredAt` was also taking the `READ` time, so a WhatsApp message that was delivered
and then opened lost the moment it actually arrived.

Fixed with a `readAt` column. **No event-history table** — the facts are few, fixed, and each
has its own natural slot; a table would be machinery for a problem four columns solve.

## Consequences

- A booking confirmation cannot fall back to SMS. Structurally, not by convention.
- A cancellation reaches somebody with no app, no data and no email — 30 minutes later, once.
- Nobody can configure themselves out of hearing about a cancelled booking.
- Marketing opt-out never withholds a ticket; a bounce never silences WhatsApp.
- Two nullable columns. No new tables, no campaign engine, no cost ledger, no fallback between
  two providers of the same channel.
