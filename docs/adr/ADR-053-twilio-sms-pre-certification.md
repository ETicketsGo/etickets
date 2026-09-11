# ADR-053: Twilio SMS pre-certification hardening

- **Status:** Accepted
- **Date:** 2026-09-11
- **Relates to:** ADR-045 (provider routing), ADR-046 (delivery receipts), ADR-051 (failure model)

## Context

An audit of the Twilio integration before any real SMS found that it could not have been
certified as written:

1. **No delivery callbacks would ever arrive.** Sends used `{ to, from, body }`. Twilio reports
   message status only to a per-message `StatusCallback` or to the Delivery Status Callback of
   the Messaging Service a message was sent through. Every SMS would have stayed ACCEPTED.
2. **Sign-in codes were in the QA and UAT logs.** The `log` SMS transport printed every body.
3. **A provider failure during phone sign-in was a 500** whose stack — carrying the provider's
   message, which names the number — was logged and reported to Sentry.
4. **Provider error prose was stored as-is** in `failureReason` and `Notification.lastError`.
5. **Callback bookkeeping never completed.** Rows were claimed as `notification:<provider>` and
   settled as `<provider>`; the update matched nothing, so every row stayed RECEIVED.
6. **An early callback was lost.** A callback arriving before the worker recorded the message
   SID found no delivery, and its key was already claimed, so it could never be applied.
7. **A STOP was filed as `BLOCKED_BY_PROVIDER`**, indistinguishable from a dead number.

## Decision

- **Messaging Service only.** `TWILIO_MESSAGING_SERVICE_SID` replaces `TWILIO_FROM_NUMBER`,
  which is removed. `from` and `messagingServiceSid` are never both sent. The SID's shape is
  checked at boot; readiness requires it and prints the exact callback URL.
- **Message content is loggable only in LOCAL/DEV** (and never under `NODE_ENV=production`),
  through one function read by the SMS and WhatsApp log transports and by phone sign-in.
  STAGING/PRODUCTION refuse to boot with SMS in log mode, behind the existing
  `ALLOW_UNDELIVERABLE_NOTIFICATIONS` escape hatch.
- **Phone sign-in isolates provider failures**: the unredeemed code is invalidated and the caller
  gets `422 SMS_UNDELIVERABLE` (not a reachable mobile, or opted out — deliberately one answer)
  or `503 SMS_UNAVAILABLE`. No provider name, code, number or stack reaches the response.
- **Provider text is sanitized** where it enters (the Twilio classifier) and again before it is
  stored for SMS/WhatsApp. The provider's error code travels separately on `TransportError`.
  Email failure text is unchanged.
- **Callbacks are settled by the id the claim produced.** An uncorrelated callback is settled
  `AWAITING_CORRELATION` with a PII-free copy of the event (hash + mask for the destination),
  applied by the worker the moment it records the SID and by a one-minute sweep, and
  dead-lettered after an hour. Nothing waits inside the HTTP request.
- **Opt-out follows Twilio, through Twilio's own keyword webhook.** Twilio Advanced Opt-Out is
  the authority: it classifies STOP/START/HELP (custom and per-language keywords included),
  replies to the sender, and blocks or unblocks at the Messaging Service. It exposes no API to
  read or report that list, so the only provider-supported synchronisation is its report of
  each keyword — `OptOutType` on the Messaging Service's incoming-message webhook.
  `POST /api/notifications/webhooks/twilio/inbound` verifies the signature, acts on `OptOutType`
  only (never the body), stores the sender only as a hash, answers empty TwiML, and records each
  inbound SID in the ledger so a redelivered STOP cannot undo a later START. STOP →
  `UNSUBSCRIBED` (re-arming a lifted row); START → lifts only that reason; HELP → nothing.
  A claimed-but-unapplied keyword is re-applied by the sweep unless a later keyword for the same
  number was already processed.
  The earlier design lifted an opt-out only when Twilio later ACCEPTED a send; scheduled sends
  are refused locally while suppressed, so that could never happen and a START was lost. The
  acceptance signal is kept as a secondary repair (an OTP Twilio accepts proves the number is not
  blocked), audited distinctly (`provider:twilio:accepted` vs `provider:twilio:start`).
  STOP reported as a send-time refusal (21610) or a status callback still suppresses too.
  Scheduled notifications check suppression before sending; phone sign-in does not, and leaves
  the decision to Twilio, which enforces opt-out itself.
- **Routing tables name only known providers**, and `PUBLIC_API_URL` must be an origin.

## Consequences

- A production environment must route SMS to a real provider to boot.
- Historic notification callback rows stuck in RECEIVED are picked up by the sweep once and
  settled; replay only ever moves a delivery forward, so it changes no delivery outcome.
- Sign-in codes are no longer visible in QA/UAT logs. Testing phone sign-in there needs a
  real SMS route or LOCAL/DEV.
- Not done: an inbound-message webhook (STOP/START/HELP arrive at Twilio and are handled there),
  and redaction of the EMAIL log transport's payload output, which is out of this scope.
