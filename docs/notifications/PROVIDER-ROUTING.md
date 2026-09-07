# Notification providers, by market

How a message gets from `NotificationService.send()` to somebody's phone, and what has to
exist outside this repository before it can.

See [ADR-045](../adr/ADR-045-notification-provider-routing.md) for why it is built this way.

---

## The launch matrix

| Channel  | India                                               | United States | Canada     |
| -------- | --------------------------------------------------- | ------------- | ---------- |
| Email    | SES                                                 | SES           | SES        |
| SMS      | **MSG91**                                           | Twilio        | Twilio     |
| WhatsApp | **MSG91**                                           | Meta Cloud    | Meta Cloud |
| Push     | Expo / FCM — the device token names its own service |

Email and push are one provider per process. SMS and WhatsApp are chosen per message.

---

## Configuration

```bash
# Email — one provider, every market.
EMAIL_PROVIDER=ses
EMAIL_FROM=tickets@eticketsgo.com
AWS_REGION=ap-south-1

# SMS + WhatsApp — per market. Unset these two and the single-provider settings
# (SMS_PROVIDER / WHATSAPP_PROVIDER) are the whole answer, which is what local
# development and QA use.
SMS_PROVIDER_BY_MARKET=IN=msg91,US=twilio,CA=twilio
WHATSAPP_PROVIDER_BY_MARKET=IN=msg91,US=cloud,CA=cloud

# Twilio (US/CA SMS)
TWILIO_ACCOUNT_SID=...
TWILIO_AUTH_TOKEN=...
TWILIO_FROM_NUMBER=+1...

# Meta WhatsApp Cloud (US/CA WhatsApp)
WHATSAPP_PHONE_NUMBER_ID=...
WHATSAPP_ACCESS_TOKEN=...

# MSG91 (India SMS + WhatsApp)
MSG91_AUTH_KEY=...
MSG91_SENDER_ID=ETGGO
MSG91_SMS_TEMPLATE_IDS=BOOKING_CANCELLED=<dlt_template_id>
MSG91_WHATSAPP_NUMBER=91...
MSG91_WHATSAPP_TEMPLATES=BOOKING_CONFIRMED=<approved_name>,BOOKING_CANCELLED=<approved_name>
```

None of these are committed. All of them go through the existing secrets infrastructure.

---

## EXTERNAL SETUP REQUIRED

**Nothing below can be created from this repository, and none of it is faked in tests.**
MSG91 will send nothing at all until every item here exists.

### India — MSG91

1. **An MSG91 account** with transactional SMS and WhatsApp enabled.
2. **A DLT registration** (TRAI). An Indian operator drops any transactional SMS whose
   wording is not an approved template sent under a registered sender id. This is a
   registration on a telecom operator's portal; it takes days, not minutes.
3. **A registered sender id** → `MSG91_SENDER_ID`.
4. **One approved DLT template per message type that uses SMS.** Today that is
   `BOOKING_CANCELLED` and nothing else. Each approved template's id goes in
   `MSG91_SMS_TEMPLATE_IDS`. With no template configured for a type, the transport refuses
   that send with a permanent error naming the exact key to set — it does not guess, and it
   does not retry.
5. **A WhatsApp business number registered with MSG91** → `MSG91_WHATSAPP_NUMBER`.
6. **One approved WhatsApp template per message type** → `MSG91_WHATSAPP_TEMPLATES`.
   WhatsApp only permits free-form text inside a 24-hour window the recipient opened by
   writing first; a booking confirmation is business-initiated, so a template is not optional.
7. **Verify the request shape against the account's own documentation.** The adapters are
   written against MSG91's published v5 API. `MSG91_BASE_URL`, `MSG91_SMS_PATH` and
   `MSG91_WHATSAPP_PATH` are configurable so a correction is not a deploy.

### United States and Canada

- **Twilio**: an account, and a number that can send to both countries.
- **Meta WhatsApp Cloud**: a verified business, a phone number id and a permanent access
  token. Already integrated; nothing new is required by Phase 1.

### Every market

- **SES** out of the sandbox, with a verified sending domain (SPF/DKIM/DMARC). Boot already
  refuses `EMAIL_PROVIDER=log` in production.

---

## What happens when a message cannot be routed

Once `*_PROVIDER_BY_MARKET` is set, the platform is multi-market, and a destination it cannot
attribute to a market is **refused** — the notification is marked `FAILED` with the reason in
`lastError`, and nothing is sent.

| Situation                                                          | `lastError`          |
| ------------------------------------------------------------------ | -------------------- |
| Destination is not E.164, or its calling code is unknown           | `unknown_market`     |
| A real market with no provider in the map (e.g. a UK number today) | `unsupported_market` |
| `+1` while the US and Canada are routed to _different_ providers   | `ambiguous_market`   |

This is deliberate. Falling through to whichever provider happened to be the default produces
a message the carrier drops or a bill at international rates, and neither is visible until a
customer says their ticket never arrived.

---

## Which messages use which channels

`apps/api/src/notifications/policy/channel-policy.ts` is the allowlist. A type that is not in
it **cannot** use SMS or WhatsApp, whatever a caller asks for.

| Type                  | email | in-app | push | WhatsApp | SMS |
| --------------------- | ----- | ------ | ---- | -------- | --- |
| `BOOKING_CONFIRMED`   | ✅    | ✅     | ✅   | ✅       | —   |
| `BOOKING_CANCELLED`   | ✅    | ✅     | ✅   | ✅       | ✅  |
| `REFUND_COMPLETED`    | ✅    | ✅     | ✅   | ✅       | —   |
| `PAYMENT_FAILED`      | ✅    | ✅     | ✅   | —        | —   |
| `EVENT_REMINDER`      | —     | ✅     | ✅   | ✅       | —   |
| `SHOW_CHANGED`        | ✅    | ✅     | ✅   | ✅       | —   |
| `SETTLEMENT_RELEASED` | ✅    | ✅     | —    | —        | —   |
| everything else       | ✅    | ✅     | ✅   | —        | —   |

SMS is allowed for exactly one thing: a cancelled booking. It is time-critical, it may be the
difference between somebody travelling to a closed venue or not, and it is the only channel
that reaches a phone with no app, no data and no email set up.

**And since [ADR-047](../adr/ADR-047-notification-policy-and-fallback.md) it is not sent
immediately.** SMS is the cancellation's FALLBACK: it opens 30 minutes later, once, and only
if none of WhatsApp, push or email got through. Sending it alongside the others would mean four
messages about one cancellation and a bill for the one the customer was least likely to need. A
push the provider accepted counts as having got through, because neither FCM nor Web Push can
report delivery and treating that silence as failure would text everybody with the app.

Sign-in codes are not in this table. Phone OTP bypasses `NotificationService` entirely so a
live credential is never written to a queryable `Notification.payload`, and it is SMS-only.
WhatsApp OTP fallback is **not** implemented: making it safe means deciding what happens when
the first channel reports success and the code never arrives, which is an authentication
decision, not a notification one.

---

## Requested but not built in Phase 1

Mapped onto what exists, rather than inventing duplicate events:

| Asked for             | Status                                                                                                            |
| --------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `TICKET_READY`        | The ticket is delivered by `BOOKING_CONFIRMED`. No separate type exists and one was not created.                  |
| `SHOW_CHANGED`        | **Built.** A material reschedule now tells every live booking on that session, inside the reschedule transaction. |
| `REFUND_INITIATED`    | No type exists; only `REFUND_COMPLETED`.                                                                          |
| `ORGANIZER_PAYOUT`    | Mapped to `SETTLEMENT_RELEASED`.                                                                                  |
| WhatsApp OTP fallback | Not built — see above.                                                                                            |

---

## Observability

`etg_notifications_total{channel,provider,result}` — result is `sent`, `skipped`, `failed`,
`retried` or `deduplicated`.

`skipped` and `failed` are separate on purpose: a skip is a message with nowhere to go (no
phone number on file) and a low steady rate is normal; a failure is a provider refusing, and
any rate of that is worth investigating.

With two SMS providers live, `provider` is what turns "messages stopped" into "MSG91 stopped".

Destinations are masked in logs to their calling code and last two digits (`+91***10`). The
MSG91 auth key travels in a header and never appears in a log line or an error message.

---

## Delivery receipts (Phase 2)

Full reasoning in [ADR-046](../adr/ADR-046-notification-delivery-receipts.md).

### What each provider can actually tell us

| Provider            | Send     | Provider ID captured | Delivery callback                         | Webhook built | Signature verification                               | Status mapped    |
| ------------------- | -------- | -------------------- | ----------------------------------------- | ------------- | ---------------------------------------------------- | ---------------- |
| SES                 | ✅       | ✅ `MessageId`       | ✅ Delivery / Bounce / Complaint, via SNS | ✅            | ⚠️ shared-secret path, **not** the SNS RSA signature | ✅               |
| SendGrid            | ✅       | ✅ `x-message-id`    | ✅ Event Webhook                          | ❌            | —                                                    | ✅ mapping ready |
| Twilio SMS          | ✅       | ✅ `sid`             | ✅ StatusCallback                         | ✅            | ✅ HMAC-SHA1 over URL + sorted fields                | ✅               |
| Meta WhatsApp Cloud | ✅       | ✅ `messages[0].id`  | ✅ `statuses[]`                           | ✅            | ✅ HMAC-SHA256 over the raw body                     | ✅               |
| MSG91 SMS           | ✅       | ✅ request id        | ✅ delivery report                        | ✅            | ⚠️ shared-secret path — **MSG91 publishes none**     | ✅               |
| MSG91 WhatsApp      | ✅       | ✅ `request_id`      | ✅                                        | ✅            | ⚠️ same                                              | ✅               |
| FCM                 | ✅       | ✅ message name      | ❌ **none exists** (BigQuery export only) | n/a           | n/a                                                  | n/a              |
| Expo                | ✅       | ✅ ticket id         | ⚠️ receipts API is **pull**, not push     | ❌            | n/a                                                  | n/a              |
| VAPID Web Push      | log-only | ❌                   | ❌ HTTP status only                       | n/a           | n/a                                                  | n/a              |

**Push stops at ACCEPTED and always will.** Neither FCM nor Web Push has a per-message
delivery callback. That is a property of the channel, not a gap in this work.

### Endpoints

```
POST /api/notifications/webhooks/twilio            X-Twilio-Signature
POST /api/notifications/webhooks/whatsapp/cloud    X-Hub-Signature-256
POST /api/notifications/webhooks/msg91/:secret     shared secret in the path
POST /api/notifications/webhooks/ses/:secret       shared secret in the path (SNS)
```

### Configuration

```bash
PUBLIC_API_URL=https://api.eticketsgo.com   # part of what Twilio signs — cannot be inferred
WHATSAPP_APP_SECRET=...                     # Meta app secret
MSG91_WEBHOOK_SECRET=<32+ random chars>
SES_WEBHOOK_SECRET=<32+ random chars>
```

### EXTERNAL SETUP REQUIRED

**Twilio** — set the Status Callback URL on the messaging service or per message.

**Meta** — subscribe the app to the `messages` webhook field and point the callback at the
endpoint above; the app secret must match `WHATSAPP_APP_SECRET`.

**MSG91** — register the delivery-report URL, including the secret, in their dashboard. There
is no signature to configure because they do not offer one.

**SES** — this is the one with real AWS work:

1. Create an SES **configuration set** and attach it to the sending identity.
2. Add an **event destination** on that configuration set publishing `Delivery`, `Bounce` and
   `Complaint` to an **SNS topic**.
3. Subscribe the topic to `https://<api>/api/notifications/webhooks/ses/<SES_WEBHOOK_SECRET>`.
4. **Confirm the subscription deliberately, in the AWS console.** The endpoint logs the
   confirmation and does not auto-confirm — an endpoint that confirms whatever it is offered
   will attach itself to any topic anybody points at it.
5. Optionally restrict the topic's subscription policy to that endpoint.

None of this is faked in tests. The receiver and normalizer are covered; the AWS side is not
provisioned from here.

### Operator surface

```
GET  /api/admin/notifications?reference=&type=&channel=&provider=&status=&from=&to=
GET  /api/admin/notifications/health?hours=24
GET  /api/admin/notifications/suppressions
GET  /api/admin/notifications/:id
POST /api/admin/notifications/:id/resend                 PLATFORM_CONFIG, audited
POST /api/admin/notifications/suppressions/:id/lift      PLATFORM_CONFIG, audited
```

Reads need `OPS_READ`; the two mutating routes need `PLATFORM_CONFIG`. Recipients are masked
and payloads are reduced to identifiers — diagnosing a delivery does not require reading
somebody's ticket. **There is no admin UI yet**; this is the backend surface.

### The guarantee, stated plainly

| Layer                          | Guarantee                                               |
| ------------------------------ | ------------------------------------------------------- |
| Notification intent creation   | **exactly once** (unique `dedupeKey`)                   |
| Worker execution               | **at least once**                                       |
| Provider receiving the message | **at least once, at best**                              |
| Webhook event application      | **exactly once** (unique `(provider, providerEventId)`) |

No provider in the launch matrix accepts an idempotency key on a send, so a crash between the
provider call and the local write means the retry is a genuinely new message to them. The
attempt row is written as `ATTEMPTING` _before_ the call so the ambiguity is visible rather
than silent. **This platform does not claim exactly-once delivery and should not be described
as offering it.**

---

## Cost accounting (Phase 4)

Full reasoning in [ADR-048](../adr/ADR-048-notification-cost-accounting.md).

### Rates are configuration, and none ship

No production prices are seeded. Real rates depend on a contract, a volume tier and a
destination operator, and a plausible invented number in an accounting table is worse than none
— it produces a total somebody will believe. **Until a rate is configured, every attempt is
recorded `UNKNOWN`, which is not zero.**

```
POST /api/admin/notifications/analytics/rates    (PLATFORM_CONFIG)
{
  "provider": "ses", "channel": "email", "country": "*",
  "unitPriceMicro": 100000,          // $0.10 per 1,000 = 100000 micro-USD per 1000
  "currency": "USD", "billingUnit": "PER_1000",
  "effectiveFrom": "2026-01-01T00:00:00Z",
  "active": true, "source": "AWS SES pricing page, retrieved 2026-01-02"
}
```

`unitPriceMicro` is **millionths of one currency unit**, not minor units. SES at a hundredth of
a cent per email cannot be expressed in cents at all.

| Provider     | Channel  | Typical billing unit                         | Notes                                                                  |
| ------------ | -------- | -------------------------------------------- | ---------------------------------------------------------------------- |
| SES          | email    | `PER_1000`                                   | Priced per thousand                                                    |
| Twilio       | sms      | `PER_SEGMENT`                                | One logical SMS is not one billed SMS                                  |
| MSG91        | sms      | `PER_SEGMENT`                                | Rupee sign ⇒ Unicode ⇒ 70 chars/segment                                |
| MSG91 / Meta | whatsapp | `PER_CONVERSATION` or `PER_TEMPLATE_MESSAGE` | Use `category` for utility vs authentication                           |
| Expo / FCM   | push     | `PER_MESSAGE` at 0                           | Configure the zero explicitly — that is `CONFIGURED_FREE`, not unknown |

Overlapping active rates are **refused**. Superseding sets an end date; nothing is deleted, so
past reports stay reproducible.

### Reporting

```
GET /api/admin/notifications/analytics/summary                     FINANCE_READ
GET /api/admin/notifications/analytics/costs?by=provider|channel|sendKind|country|event|booking
GET /api/admin/notifications/analytics/providers
GET /api/admin/notifications/analytics/events
GET /api/admin/notifications/analytics/rates
```

Filters: `from`, `to`, `provider`, `channel`, `eventType`, `tenant`. Default window is 30 days —
an unbounded scan of this table is an incident, not a report.

**Every total carries `unknownCostAttempts` beside it.** Until that is zero the total is a
floor. **Currencies are never added**; USD and INR come back as separate rows and there is no
FX anywhere.

### What the numbers mean

- `notifications` — messages the platform decided to send.
- `attempts` — times a provider was asked to carry one. Always ≥ notifications; a retry, a
  fallback and an operator resend raise this and not the other.
- `sendKind` — `PRIMARY` / `RETRY` / `FALLBACK` / `MANUAL_RESEND`. The emergency SMS and
  support's resends are separable from ordinary traffic.
- `outcomeClass` — whose failure it was. `POLICY_SUPPRESSED` and `NO_DESTINATION` are ours and
  are excluded from provider health entirely.
- `deliveryMeasurable: false` on push — FCM and Web Push have no per-message delivery callback,
  so there is no delivery rate to report and a 0% would be a fabrication.

### EXTERNAL SETUP REQUIRED

1. **Configure a rate per provider, channel and market you actually use**, from your contracts
   or invoices. Nothing is priced until you do, and every report will say so.
2. Configure push explicitly at zero if it is free on your plan — a configured zero is
   `CONFIGURED_FREE` and counts as a complete answer; an absent rate is `UNKNOWN` and does not.
3. Set `category` rates for WhatsApp if your provider prices utility and authentication
   differently.
4. **Historical rows stay `UNKNOWN`.** Nothing was backfilled — writing zeros would turn "we
   do not know" into "it was free" for every message sent before this phase.
