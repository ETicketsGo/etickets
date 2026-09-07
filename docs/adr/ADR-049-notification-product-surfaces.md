# ADR-049: Producers, preferences, and the rollout of WhatsApp opt-in

- **Status:** Accepted
- **Date:** 2026-09-07
- **Extends:** [ADR-045](./ADR-045-notification-provider-routing.md) … [ADR-048](./ADR-048-notification-cost-accounting.md)
- **Scope:** Provider-neutral notification platform, Phase 5

## Context

Four phases produced a notification platform that was backend-complete and product-inert. It
could route, deliver, prove, price and police messages — but a customer could not see or
change a single preference, nothing asked whether WhatsApp was welcome, a cancelled show
notified nobody, and `EVENT_REMINDER` had a policy and no producer.

## Decision

### 1. Preferences get an HTTP surface, not a second model

`NotificationPreferenceService` has existed since ADR-020 and is read on every send. What was
missing was the endpoint. `GET/PUT /me/notification-preferences` is it.

The response carries `required` and `deferred` per channel, and both clients read that rather
than deciding for themselves — a rule two clients apply separately is a rule they will
eventually apply differently.

**Required channels are shown, not hidden.** There were two ways to reflect a guaranteed
channel and only one is honest. A toggle would lie twice: by implying the message can be
stopped, and again when it arrives anyway. Hiding it would leave somebody unable to see that
we email them about their bookings — exactly what a privacy-minded person opened the page to
find out.

**The emergency SMS is not a toggle.** It opens only if a cancelled show reached somebody
nowhere else. Offering to disable the message that exists to catch every other message failing
is not a choice worth offering.

### 2. Destination readiness comes from the notification API

`hasPhone`, `phoneVerified`, `emailUsable` ride on the preferences response, because that is
the API that knows what a destination _is_ — the account's own number, which is what the SMS
and WhatsApp channels resolve at send time. A WhatsApp switch offered to somebody with no
phone number is a switch that cannot work; the UI now says so and links to the existing
profile flow. **No second phone-collection or verification path was built.**

### 3. WhatsApp transactional opt-in reuses the consent table

`whatsapp:transactional` is a scope on `MarketingConsent`, added to `CONSENT_CHANNELS`. The
`source` now records the scope (`account-settings:whatsapp:transactional`), because
"granted transactional WhatsApp" and "granted marketing WhatsApp" are two different
permissions and a history that records both identically cannot tell them apart afterwards.

The UX asks them separately and says what each is not. **No new consent table.**

### 4. Rollout, in three stages

`WHATSAPP_TRANSACTIONAL_OPT_IN_REQUIRED` stays **off**. Flipping it now would stop every
existing customer's WhatsApp overnight — absence of a consent record correctly means no, and
applying that retroactively to people who were never asked is an outage, not compliance.

| Stage                   | Action                                                                                                                | Exit condition                                                                                                           |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **1 — collect** _(now)_ | Settings UX live, enforcement off. Consent recorded for anyone who opts in.                                           | Opt-in rate readable from `MarketingConsent`; a meaningful share of active customers has answered.                       |
| **2 — verify**          | Still off. Compare WhatsApp volume against opt-ins; confirm the copy is being understood.                             | The gap between "receiving WhatsApp" and "opted in" is understood and acceptable.                                        |
| **3 — enforce**         | Set the flag. Missing opt-in removes **WhatsApp only**; email and push are untouched and the notification still goes. | Watch `etg_notifications_total{channel="whatsapp",result="suppressed"}` — a spike means stage 1 did not run long enough. |

Reversible at every stage: the flag off restores previous behaviour immediately, and no
consent record is lost.

### 5. `SessionCancelled` produces the notification — through the event, not a call

`cancelShow` records `showCancelledEvent` via `recordInTransaction`, in the same transaction
that cancels the session. It calls no notification service.

`session.cancelled` carries two different facts — a vendor feed's session (`ProviderSession`)
and one of our own shows (`EventSession`) — so the handler discriminates on `aggregateType`.
That is what `aggregateType` is for; a second event name for the same event would have been
the duplication the brief warned against.

### 6. Recipient eligibility

`CONFIRMED` and `PARTIALLY_REFUNDED`, and nothing else. A `PENDING_PAYMENT` hold has no ticket
to lose; a `CANCELLED` booking walked away; a `REFUNDED` one has its money back and holds no
seat. A partly refunded booking still has live tickets and is very much affected. Wrong in
either direction is expensive: too wide and we pay for emergency SMS to people with no stake,
too narrow and somebody travels to a dark venue.

### 7. Fan-out: no cursor, no job state, no new table

The work describes itself. "Who still needs telling" is a `NOT EXISTS` against the
notifications already written, so **progress is implicit in the rows**.

Every hard part falls out of that. A worker killed mid-batch leaves the rest still matching
the query. Two workers cannot double-send, because the dedupe index decides that in the
database. A redelivered event is a no-op. There is nothing to reconcile.

The handler starts one batch immediately, so the first customers hear within seconds. **The
sweep is the guarantee** — it recovers from a failed handler, a disabled outbox, or a process
that died between commit and dispatch.

This is a _different_ durability mechanism from `sendCritical`, and `critical-producers.spec.ts`
now recognises it explicitly — and checks it, requiring the exempted file to actually contain
a sweep and a `NOT EXISTS`. An exemption that is not verified is a way to silence a guard.

### 8. Reminders: an instant, not a local time

"Twenty-four hours before" is a duration before an instant, so it is another instant. No
timezone arithmetic is done, and that is not a shortcut — it is why this is correct through
daylight saving. A Sydney show at 19:00 local on the day the clocks change is one specific
moment; computing "the same time yesterday" locally is what sends a reminder an hour early
twice a year. The **rendering** does convert, to the venue's own zone, and that belongs to the
template.

**Eligibility is checked when it fires, not when it was planned.** A day is long enough for a
show to be cancelled or a booking refunded, and a reminder for a show that is off is worse
than none — the customer now believes it is on. So nothing is scheduled ahead; the sweep asks
at the moment it would send.

**OFF by default.** Turning reminders on starts messaging every ticket holder about every
future show. That is a product launch, not a deployment.

### 9. Quiet hours — deferred, with the reason

The platform stores no per-user timezone. Reminders would have to be held against a local
clock that does not exist, so implementing quiet hours means either a new user preference and
a scheduling engine to honour it, or guessing from a venue's zone — which is wrong for anybody
who booked while travelling.

Reminders already run on a five-minute sweep and could be windowed later against a real
preference. Building the engine before the preference exists is architecture for a feature
nobody has specified. **Deferred.**

### 10. Readiness reports presence, never value, and sends nothing

`GET /admin/notifications/readiness` returns `CONFIGURED` / `PARTIAL` / `MISSING` / `DISABLED`
per market and channel. Every check asks whether a key is _set_; none read what it contains.

A configured provider with no rate is `PARTIAL`, not `CONFIGURED` — one that can send and
cannot be costed produces reports whose totals are silently a floor. MSG91 without templates
is `PARTIAL` for the same reason: it will carry nothing, and the appearance of readiness is
worse than its absence.

**It does not claim webhooks are healthy.** Whether Twilio is posting to our callback URL is a
fact about Twilio's dashboard; the report says the secret is configured and says that is all
it means.

### 11. Test send: real path, operator's own destination

`POST /admin/notifications/readiness/test-send`, `PLATFORM_CONFIG`, audited, labelled
`MANUAL_RESEND` so it is separable in every cost report. (**Superseded by
[ADR-050](./ADR-050-notification-launch-certification.md) §2**: certification traffic is now
`TEST`. `MANUAL_RESEND` means support spending money on a customer's behalf, and filing test
sends there made every certification run look like a support incident.) It goes through the real policy,
suppression and routing — a test that bypassed those would prove the bypass works.

The destination is typed by the operator. Resending a real customer's booking would message
somebody who did not volunteer and put an event in their history that never happened to them.

## Consequences

- A customer can see and change what reaches them, on web and on mobile, with the same rules.
- A cancelled show reaches its audience asynchronously, resumably, and exactly once each.
- Reminders exist, are timezone-correct, and are off until somebody decides to launch them.
- `EVENT_REMINDER` and `SHOW_CANCELLED` both have producers; neither did before.
- No new tables, no new migration.
- Deferred and documented: quiet hours, and the localisation of message copy beyond en/fr-CA.
