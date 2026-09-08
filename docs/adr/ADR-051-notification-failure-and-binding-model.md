# ADR-051: Telling failures apart, and binding templates we do not own

- **Status:** Accepted
- **Date:** 2026-09-07
- **Extends:** [ADR-045](./ADR-045-notification-provider-routing.md) … [ADR-050](./ADR-050-notification-launch-certification.md)
- **Scope:** Provider-neutral notification platform, Phase 7

## Context

External provider setup is paused: India's DLT registration is incomplete, so no sender header
is active, no template can be approved, and no credential or callback exists for any provider.
The question for this phase was what remains genuinely buildable — and, more usefully, what the
absence of providers had been hiding.

Three things, as it turned out, and all three share a shape: a component correct in isolation
and wrong in composition, silent about the difference.

## Decision

### 1. A failure says what went wrong, not merely that something did

Every failed send recorded `outcomeClass: PROVIDER_UNAVAILABLE`. That one classification
covered a missing MSG91 auth key, an unapproved DLT template, a number that does not exist, a
rate limit, and a provider genuinely being down — and three of those five are not the
provider's doing at all.

The consequences were not cosmetic:

- **Provider health counted our own unfinished setup against the provider.** A market with no
  MSG91 account produced an unbroken run of "MSG91 unavailable" — the exact signal that is
  supposed to mean MSG91 is down. The number meant to detect an outage was pinned at 100%
  before the account existed, and a real outage would have been invisible inside it.
- **The retry loop treated a permanently missing template as worth three more attempts**, at
  five-second intervals, against a template that will not exist until a telecom operator
  approves it next week.
- **An operator could not tell "somebody must finish the DLT registration" from "wait five
  minutes"**, because `status=FAILED` returned both in one undifferentiated list.

`FailureClass` carries ten values, mapped onto `OutcomeClass` so the two can never disagree
about a single attempt, and `OutcomeClass` gains `CONFIGURATION_BLOCKED` — deliberately outside
`isProviderOutcome` and `reachedProvider`, so a configuration failure counts against nobody's
reliability and nothing is ever priced for a call that was never made.

**`retryable` is now derived from the class rather than asserted by the caller.** That ordering
is the durable part: a future adapter cannot mark a missing credential retryable, because
retryability is no longer something a call site gets to decide.

### 2. The Meta WhatsApp adapter could never have worked

It sent `type: 'text'`. WhatsApp permits free-form text only inside a 24-hour window that the
RECIPIENT opens by writing to the business first, and every message this platform sends is
business-initiated — a booking confirmation, a cancelled show. Meta refuses the send.

The first real North American WhatsApp message would have been rejected, at the moment
credentials were first configured, and the 400 would have read as a bad credential rather than
a bad message shape. The MSG91 transport had sent templates all along, for exactly this reason;
the capability matrix declared `cloud.requiresTemplate: true`; nothing checked the adapter
against either. It now sends an approved template, and a structural test asserts that every
provider requiring one has a way to be given one.

### 3. Provider capabilities are written down once

The same facts were relied on in four places that could not see each other: certification knew
push has no delivery receipt, the webhook handler knew MSG91 publishes no signature, the
transports knew MSG91 requires a template. Each copy was correct, and the day a provider
changes — or a fifth is added — the copies drift and the disagreement surfaces as a message
nobody can explain.

`PROVIDER_CAPABILITIES` is the single table, and it describes the ADAPTER as implemented rather
than the vendor's brochure: SendGrid is `deliveryMeasurable: false` because this repository has
no SendGrid event handler, whatever SendGrid supports.

### 4. Template bindings gain the three dimensions they were missing

`MSG91_SMS_TEMPLATE_IDS=TYPE=id` works exactly as long as there is one provider per channel and
one language. This platform had already committed to neither:

- Quebec must be written to in French. WhatsApp templates are approved **per language** with
  different ids, and one id per type cannot express it — the failure being not an error but an
  English message sent confidently to a French speaker.
- Meta and MSG91 both carry WhatsApp in different markets with different names for the same
  notification, and one map per channel has nowhere to put the provider.
- WhatsApp prices by **category**, the rate card is keyed by it, and there was nowhere to
  record it — so every WhatsApp message was priced at whatever single rate somebody entered.

`provider:channel:TYPE:locale[:category]=externalId`. Resolution falls back exact locale →
base language → explicit `*`, and **never to another locale**: sending an English-approved
template to a French speaker is the wrong language delivered confidently, which is worse than
a refusal readiness can name.

The superseded keys still work, read at lower priority as wildcard-locale bindings. Dropping
them would have turned a configured India into an unconfigured one at the moment somebody
deployed this, with every SMS permanently refused, looking exactly like a code defect.

### 5. Market enablement is separate from provider routing

Readiness reported a hardcoded `IN, US, CA` and marked the platform not-ready because Canada
had no MSG91 templates — for a Canada nobody had decided to launch. A report that cannot
distinguish a blocker from an unopened market is a report people learn to ignore.

`NOTIFICATION_MARKETS` states what is open. A disabled market demands no credentials and
contributes no blockers; an enabled one must be complete and says so. Boot **refuses** a
routing table naming a market that is not enabled — not because it is incomplete, but because
it is contradictory, and no default can choose which of the two statements was meant.

### 6. India's DLT block is its own state

`MISSING` reads as "somebody forgot to set a variable", and the fix for that is five minutes.
DLT registration is a telecom operator, a legal entity and several days, and it gates every SMS
the platform will ever send in India. `BLOCKED_DLT` puts those in different columns.

The PE ID and sender header are recorded as configuration, never as code constants — they are
issued to a specific legal entity and can be revoked. Nothing here validates against a telecom
system, and the platform says only what it was told.

### 7. Validation happens before the provider call, and only where it must

A blank required variable renders a grammatical, confident, useless sentence: "Your event has
been cancelled", to somebody holding tickets for four different shows.

On a **templated** channel it is worse than useless — a DLT template has a fixed variable
count, so a blank produces a message the approval no longer matches, refused at the carrier or
delivered with a hole in it. So the contract is enforced on SMS and WhatsApp, and deliberately
**not** on email or the inbox: there the same gap renders a vaguer sentence, and a vague warning
about a cancelled show is far better than silence.

### 8. Reporting exists for the approvals that have not happened yet

Both remaining blockers are approvals of TEXT, both are slow, and both are priced by what the
text turns out to be. An Indian SMS is billed per 160-character GSM-7 segment and drops to 70
the instant one character falls outside that alphabet — a rupee sign does it, a curly quote
pasted from a document does it — tripling the price of every message sent under that approval,
for as long as it lasts.

`/readiness/templates/sms` measures the real rendered copy and names the offending characters.
It never rewrites anything: shortening approved wording is a compliance decision belonging to
whoever signs the registration, and a tool that silently trimmed a sentence would produce a
message no longer matching its approval.

### 9. A link in a notification must be on a host we own

The push channel read `payload.url` and handed it to the device as the tap target. A payload is
assembled by whichever service is sending, so any producer — present, future, deliberate or
mistaken — could put any URL into a notification arriving under this platform's name and icon.
That is a phishing primitive with our branding on it, needing no compromise to exercise.

Links are checked against the configured site origins, HTTPS only, and an unowned link is
**dropped while the message still goes**: refusing the send would let a bad link suppress a
message the customer is owed.

### 10. `CONTRACT_TESTED` is a rung, and it is below live

Thirty tests put every adapter through rate limits, expired tokens, unapproved templates, dead
numbers, timeouts, malformed bodies and Twilio's own error codes. They prove our side, and
nothing about the provider's: no credential exists and no request leaves the repository.

Nothing automated may write `LIVE_CERTIFIED` — the evidence service throws if asked. A platform
that could certify itself would have certified itself months before anybody opened an account.

### 11. Suites whose subject is global state are serialized

Several things here are global and right to be: the sweep delivers everything owed; the
certification ladder asks whether ANY message through a provider has ever been accepted. Jest
runs suites in parallel workers against one Postgres, so a suite writing that state ran
alongside a suite asserting on it — passing alone, failing in a full run.

A Postgres advisory lock says exactly what is true, in the code that has the constraint, rather
than in a CI flag that would cost every other suite its parallelism. It takes its own
single-connection client, because a session lock belongs to the connection that took it and
Prisma pools — unlocking through a different pooled connection would leave the lock held for
the rest of the run.

`dispatchDue` was deliberately **not** given a scope parameter. A sweep that only sweeps some
of what is owed is a worse sweep, and a filter whose only real caller is a test is one the first
person to use in earnest would quietly stop delivering somebody's notifications with.

## Consequences

- An operator can ask "what is blocked on me" and get an answer.
- An unconfigured market no longer looks like a provider outage.
- A missing template fails on the first attempt, visibly, instead of the third.
- Meta WhatsApp can work at all.
- French templates are expressible; category-based pricing is expressible.
- India's blocker is reported as a registration, not a typo.
- 2897 API tests green, across five consecutive full runs.
- **Nothing external changed.** No credential exists, no message has been sent, and no provider
  is certified. This phase changed what the platform can prove and report; it did not change
  what has been proven, which remains nothing.
- Deferred and written down: bulk resend, an admin console screen, quiet hours, pull-based
  receipt reconciliation, and locales beyond `en` / `fr-CA`.
