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
| `SETTLEMENT_RELEASED` | ✅    | ✅     | —    | —        | —   |
| everything else       | ✅    | ✅     | ✅   | —        | —   |

SMS is allowed for exactly one thing: a cancelled booking. It is time-critical, it may be the
difference between somebody travelling to a closed venue or not, and it is the only channel
that reaches a phone with no app, no data and no email set up.

Sign-in codes are not in this table. Phone OTP bypasses `NotificationService` entirely so a
live credential is never written to a queryable `Notification.payload`, and it is SMS-only.
WhatsApp OTP fallback is **not** implemented: making it safe means deciding what happens when
the first channel reports success and the code never arrives, which is an authentication
decision, not a notification one.

---

## Requested but not built in Phase 1

Mapped onto what exists, rather than inventing duplicate events:

| Asked for             | Status                                                                                                                     |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `TICKET_READY`        | The ticket is delivered by `BOOKING_CONFIRMED`. No separate type exists and one was not created.                           |
| `SHOW_CHANGED`        | **No type and no producer.** `rescheduleShow` notifies nobody today. Real gap, needs a product decision, not a policy row. |
| `REFUND_INITIATED`    | No type exists; only `REFUND_COMPLETED`.                                                                                   |
| `ORGANIZER_PAYOUT`    | Mapped to `SETTLEMENT_RELEASED`.                                                                                           |
| WhatsApp OTP fallback | Not built — see above.                                                                                                     |

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
