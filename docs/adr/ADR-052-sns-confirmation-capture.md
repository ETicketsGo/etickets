# ADR-052: Holding an SNS confirmation token long enough for a person to use it

- **Status:** Accepted
- **Date:** 2026-09-09
- **Extends:** [ADR-050](./ADR-050-notification-launch-certification.md), [ADR-051](./ADR-051-notification-failure-and-binding-model.md)
- **Scope:** SES delivery events over SNS

## Context

Two earlier decisions were each correct and, together, produced a process no human could
complete.

The SES webhook **refuses to auto-confirm** an SNS subscription. A valid signature proves the
message came from Amazon; it does not prove this platform wants to be attached to that topic.
An endpoint that confirms whatever subscription is offered will attach itself to any topic
anybody with an AWS account points at it, and then believe the events from it. So confirmation
was made a deliberate human act.

The handler also **logs only the SubscribeURL's host**, never the URL. The URL carries a token
that authorises the confirmation, and a token written to a log is a token in every aggregator,
backup and screenshot from then on.

Both hold. But the token arrives exactly once, in the message body, and the only place it was
ever written was the log we deliberately kept it out of. So the design demanded a manual step
and destroyed the only artifact needed to take it. The subscription could not be confirmed at
all — discovered when an operator asked for the URL and there was nothing to give them.

## Decision

Outside production, and only there, a signature-verified `SubscriptionConfirmation` is written
to one row and revealed once through an authenticated, audited route.

### The signature stays authoritative, and capture happens strictly after it

Nothing is stored until `SnsVerifier` has verified the message. The environment guard is then
checked **again inside** `capture`, so a future caller that forgets the first gate still cannot
write a token into a production database. Two HTTP-level tests assert that an unsigned envelope
and a body altered after signing both store nothing; both fail if the capture call is moved
above the signature check.

### The environment gate is an allowlist, keyed on `APP_ENV`

`LOCAL, DEV, TEST, CI, QA, UAT` may capture. Everything else is refused, including an unset or
unrecognised value — a denylist would mean a typo or a new environment name silently defaults
to permitted, which is the wrong direction for a mistake in this file.

It is keyed on `APP_ENV` and not `NODE_ENV` because QA and UAT both run `NODE_ENV=production`.
A `NODE_ENV` guard would refuse in exactly the environments this exists for. Only `APP_ENV`
distinguishes "built like production" from "serving real customers".

### It is not encrypted at rest, and that is stated rather than papered over

This repository has no key-management or encryption abstraction. Inventing one for a single
QA-only column would be the worse outcome: a general secret store is a real design decision
with key rotation, access control and recovery attached, not a side effect of a webhook fix.
So the row is protected by **never being written outside a non-production environment** rather
than by cryptography. In QA the same database already holds test bookings and notification
payloads; a token that expires in seventy-two hours is not the most sensitive thing in it.

If this is ever wanted in production, the encryption question has to be answered first — not
this guard relaxed.

### Reveal is one-time, and the strictness is cheap

A value that can be read repeatedly is one an audit trail cannot account for: the fifth read
looks exactly like the first. The first read is stamped and every later attempt is refused and
separately audited. Being wrong costs nothing — AWS issues a fresh token from the SNS console
on demand, so a lost reveal is a button, not an incident.

The URL never appears in the status route, in audit metadata, in metrics, or in any log line at
any level. A test spies on every `Logger` method and asserts the token appears in none of them,
because a future edit that helpfully logs the URL "for debugging" would undo the entire reason
this table exists and would look perfectly reasonable in review.

### A newer confirmation supersedes an older one

Clicking **Request confirmation** twice in the SNS console produces two valid-looking tokens,
of which AWS honours the newest. Without supersession, "the pending confirmation" is ambiguous
and an operator could paste a token the console rejects — whose obvious reading is that this
endpoint is broken. Older pending rows for the same topic are marked `EXPIRED`.

### Idempotency is the unique index, not the code

SNS redelivers a confirmation with the same `MessageId` when it does not get a prompt 2xx —
which is precisely what happened while the QA api was asleep. `messageId` is unique, so a
redelivery is a no-op, and a redelivery after a reveal does not un-reveal the row. Proven
against real PostgreSQL, because the guarantee is the schema's, not the service's.

### `CONFIRMED` is set by a person

Nothing in this process can observe AWS accepting a token. A status the platform inferred would
be a status nobody could trust, so an operator records it explicitly.

## Consequences

- The manual-confirmation design can actually be carried out, without weakening it.
- Production behaviour is unchanged: it captures nothing and both routes refuse.
- The token's blast radius is one row, one capability, one read, seventy-two hours.
- This is **not** a secret store and nothing else may be put in it. A general "reveal a secret"
  facility is a separate decision; acquiring one as a side effect of a webhook fix is how a
  platform ends up with an unaudited credential viewer.
- Still true, and unchanged by this: no SES message has been sent, no delivery event has been
  received, and no provider is certified.
