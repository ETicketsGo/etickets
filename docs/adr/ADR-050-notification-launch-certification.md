# ADR-050: What it takes to call a notification channel live

- **Status:** Accepted
- **Date:** 2026-09-07
- **Extends:** [ADR-045](./ADR-045-notification-provider-routing.md) … [ADR-049](./ADR-049-notification-product-surfaces.md)
- **Supersedes:** ADR-049 §11 (test sends are `TEST`, not `MANUAL_RESEND`)
- **Scope:** Provider-neutral notification platform, Phase 6

## Context

Five phases produced a platform that routes by market, delivers durably, records receipts,
applies policy and consent, prices what it sends, and gives customers and operators a surface.
Every one of those is a statement about **our** code. None of them is a statement about
whether a message reaches an actual handset in Vijayawada.

Nothing external is configured. No credential for SES, SNS, MSG91, Twilio, Meta or FCM exists
in this repository or in any environment it can see. So the question this phase had to answer
was not "is it built" — it was "how does anybody tell the difference between built and
working, without being able to fake the answer".

Two things also turned out to be wrong while writing the setup guide, and both would have
been discovered on launch night.

## Decision

### 1. Readiness is a ladder with four rungs, and configuration is the second

A boolean is the wrong shape. "Ready" collapses two very different states — _we have typed the
credentials in_ and _a message has demonstrably arrived_ — and the gap between them is where
every launch failure lives.

| Level                            | What has been proven                                                         |
| -------------------------------- | ---------------------------------------------------------------------------- |
| `CODE_READY`                     | The adapter, routing and callback handler exist. Nothing is configured.      |
| `CONFIG_READY`                   | Credentials and templates are present. **Nothing has ever been sent.**       |
| `EXTERNAL_VERIFICATION_REQUIRED` | Sends are accepted — but no callback has ever come back, or no rate exists.  |
| `LIVE_CERTIFIED`                 | A real send was accepted, a real callback arrived, and a rate is configured. |

**The evidence is read from `NotificationDelivery`, never from configuration.** The certifier
asks: is there a `TEST` send, does it have an `acceptedAt`, does any row for this provider
carry a `providerStatus` — which only a provider can have written — and is there an active
rate. A variable being set proves that somebody typed a variable.

This is what makes the ladder resistant to its own operator. You cannot reach `LIVE_CERTIFIED`
by editing config, and the only way to fake it is to fabricate delivery rows, which is
exactly the thing the runbook forbids and which no amount of API access does for you.

**A market reports its weakest channel.** Email working in India is not India working, when
every buyer there expects WhatsApp. Reporting the best channel would be technically true and
practically a lie about launch.

### 2. Operator test traffic is `TEST`, not `MANUAL_RESEND`

ADR-049 classified test sends as `MANUAL_RESEND`, reasoning that both are an operator
deliberately causing a message. That conflates two things which need to be told apart.

`MANUAL_RESEND` is support spending money **on a customer's behalf** — a real person did not
get their ticket and somebody sent it again. `TEST` is certification traffic that has no
customer at all. Filed together, every certification run inflates the support figure, and
every quiet month of testing looks like a support incident.

`SendKind.TEST` and `isCustomerTraffic()` make the distinction structural rather than a
convention. The **cost stays visible** — a WhatsApp test in India is real money and hiding it
would be the same error in the other direction. What changes is only the attribution, and
customer denominators (cost per booking, messages per customer) exclude it.

### 3. SNS signatures are verified for real

The previous handler leaned on a shared secret in the path. That is defence-in-depth and it
is not a signature: anyone who ever sees a URL — a log, a proxy, a screenshot — can post
whatever they like to it. What such a post can do is **suppress a destination**, which is a
way to stop a named person receiving their tickets.

`sns-verifier.ts` does the real thing: canonical string over the signed fields for the message
type, RSA-SHA1 (v1) or RSA-SHA256 (v2) against the certificate at `SigningCertURL`.

The certificate URL is the whole attack surface, so it is constrained before it is fetched:

- **HTTPS only.**
- Host must `startsWith('sns.')` **and** end with `.amazonaws.com` or `.amazonaws.com.cn`.
  Both halves matter — `sns.evil.com` fails the suffix, `evil-sns.amazonaws.com.attacker.net`
  fails the host check, and a bare suffix test would pass something like
  `s3.amazonaws.com/attacker/cert.pem`.
- Every non-network check runs **before** any fetch, so a malformed message never becomes an
  outbound request. Otherwise the endpoint is a server-side request forgery primitive that
  anyone on the internet can aim.
- 5-second timeout, 32KB body cap, `BEGIN CERTIFICATE` required, 32-entry bounded cache.

`SubscriptionConfirmation` is verified and still **not auto-confirmed**. An endpoint that
confirms whatever it is offered attaches itself to any topic anybody points at it. A human
clicks confirm in the console, having read a log line that says the signature checked out.

The path secret stays, checked first. It is cheap, it sheds noise before any crypto, and
removing a working control because a better one arrived is how controls get lost.

### 4. Two gaps that only writing the setup guide exposed

Both were invisible from inside the code, and both are the same shape: **everything reports
success and nothing happens.**

**SES was never told which configuration set to send under.** SES publishes delivery, bounce
and complaint events only for messages sent _with_ a configuration set that has an event
destination. Without `ConfigurationSetName` the mail goes out, the API returns a message id,
the row says `ACCEPTED` — and not one callback ever arrives. The topic would be configured, the
subscription confirmed, the endpoint verifying signatures correctly, and nothing would ever be
marked delivered or suppressed. Now `SES_CONFIGURATION_SET`.

**Meta's subscription challenge did not exist.** Meta will not activate a webhook subscription
until it has issued a `GET` with a verify token and received the `hub.challenge` back. Without
that endpoint the subscription cannot be created at all — so the (correct, signature-verifying)
POST handler is simply never called, because Meta never starts sending. Now a `GET` on the same
path, comparing `WHATSAPP_VERIFY_TOKEN` in constant time and echoing the challenge only after
the token checks out. Echoing first would make it an open reflector for anyone who found the
URL; a naive `===` would leak the token through timing.

Neither is exotic. Both are the kind of thing found by writing down what a person has to do in
someone else's console, which is an argument for writing that down before launch rather than
during it.

### 5. Documentation states what is not done, in the same table as what is

`PROVIDER-SETUP.md`, `QA-CERTIFICATION.md` and `PRODUCTION-RUNBOOK.md` all open by saying that
nothing has been run and every provider is `BLOCKED_EXTERNAL_SETUP`. A setup guide that reads
as though it has been followed is worse than no guide: it invites somebody to assume the steps
are behind them.

The certification report exposes `externalActions` per channel — the exact console, the exact
setting — because "not configured" is a problem statement and "add an event destination to the
configuration set, in the SES console" is a next action.

**No secret appears in any of it**, and a test asserts that the readiness report never contains
one. A report about credentials is precisely the report somebody pastes into a ticket.

## Consequences

- There is a defensible answer to "is India live", per channel, sourced from delivery evidence.
- Certification cannot be reached by configuration alone, by design.
- Cost reports separate customer traffic from certification traffic without hiding either.
- The SNS endpoint is genuinely authenticated rather than URL-secret authenticated.
- Two silent launch-night failures are fixed before launch night.
- **Everything external remains `BLOCKED_EXTERNAL_SETUP`.** This ADR changes what the platform
  can prove; it does not change what has been proven, which is nothing.
- Deferred and written down: **bulk resend** after a provider outage — recovery is
  per-notification today, which does not scale past a few hundred.
