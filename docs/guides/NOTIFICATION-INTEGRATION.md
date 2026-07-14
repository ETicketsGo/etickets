# Notification Integration Guide

ETicketsGo delivers notifications through a single **`NotificationChannel`** abstraction
(`apps/api/src/notifications/channels/notification-channel.interface.ts`). Each channel now
delegates the actual send to an injected **transport**, selected per channel by an
environment variable. The MVP default for every channel is **`log`** — the original
log-only behaviour — so dev, test, and e2e boot with **none** of the provider keys below.

| Channel  | `<CHANNEL>_PROVIDER` values        | Real transport SDK / API                                 | Recipient source                             |
| -------- | ---------------------------------- | -------------------------------------------------------- | -------------------------------------------- |
| Email    | `log` (default), `sendgrid`, `ses` | `@sendgrid/mail` / `@aws-sdk/client-sesv2`               | `notification.toEmail`                       |
| SMS      | `log` (default), `twilio`          | `twilio`                                                 | `payload.phone`                              |
| WhatsApp | `log` (default), `cloud`           | WhatsApp Business Cloud API (`fetch`, no SDK)            | `payload.phone`                              |
| Push     | `log` (default), `fcm`             | `firebase-admin`                                         | `payload.pushToken` / `payload.pushTokens[]` |
| In-app   | — (unchanged)                      | none — the persisted `Notification` row _is_ the message | `userId`                                     |

`NotificationService`, the template service, preferences, scheduling, and the retry /
delivery-status lifecycle were **not changed** to add real providers. Only the delivery
transport _inside each channel's `deliver()`_ was made swappable.

> **Sandbox vs production is not a code change.** It is purely _test_ vs _live_
> keys/tokens. Set the test credentials for sandbox, swap in live credentials for
> production. Nothing else differs.

---

## 1. How selection works

Each channel's `<CHANNEL>_PROVIDER` variable (validated in
`apps/api/src/config/configuration.ts`, default `log`) selects that channel's transport.
The DI bindings live in `apps/api/src/notifications/notifications.module.ts`:

```ts
{ provide: EMAIL_TRANSPORT,    inject: [ConfigService], useFactory: selectEmailTransport },
{ provide: SMS_TRANSPORT,      inject: [ConfigService], useFactory: selectSmsTransport },
{ provide: WHATSAPP_TRANSPORT, inject: [ConfigService], useFactory: selectWhatsAppTransport },
{ provide: PUSH_TRANSPORT,     inject: [ConfigService], useFactory: selectPushTransport },
```

Each `select*Transport` factory (in `channels/transports/*.transport.ts`) **constructs only
the selected transport**. So SendGrid/SES/Twilio/FCM credentials are never required unless
you actually choose that provider — the `log` default needs zero config. If you select a
real provider but omit its keys, construction **fails fast** with a clear error naming the
missing variable (e.g. `EMAIL_PROVIDER requires SENDGRID_API_KEY to be set.`).

Each channel injects its transport token and defaults the constructor parameter to the log
transport, so a channel is still directly constructable without DI (used by the unit tests).

**Provider errors propagate; "no recipient" is a clean skip.** A real transport lets its
provider error bubble out of `deliver()` so `NotificationService`'s existing retry /
`FAILED`-status path handles it. The one exception is a **missing recipient** on
SMS/WhatsApp/push (no `payload.phone` / `pushToken`): the transport logs a warning and
returns without sending — it is a skip, not a failure.

The **`log` default keeps all existing unit tests and e2e green** — channels behave exactly
as before unless a provider is explicitly selected.

---

## 2. Which notification types map to which channels

All six notification types are **fully templated** (subject + body) in
`apps/api/src/notifications/templates/notification-template.service.ts`, and the same
rendered template is delivered on whichever channel(s) a send resolves to:

| `NotificationType`  | Emitted from                                     | Templated |
| ------------------- | ------------------------------------------------ | --------- |
| `BOOKING_CONFIRMED` | `PaymentsService` (on `payment.succeeded`)       | ✅        |
| `PAYMENT_FAILED`    | `PaymentsService` (on `payment.failed`)          | ✅        |
| `REFUND_COMPLETED`  | `RefundsService`                                 | ✅        |
| `TICKET_CHECKED_IN` | `CheckinsService` (when the ticket has an email) | ✅        |
| `EVENT_REMINDER`    | (templated; the intended `schedule()` use case)  | ✅        |
| `BOOKING_CANCELLED` | (templated; ready for a future call site)        | ✅        |

**Channels are chosen per send, not per type.** `NotificationService.send`/`schedule`
resolve channels from the caller's `channels` argument (default `['email']`), then filter
them through per-user opt-outs in `NotificationPreferencesService`. Any type can therefore
be delivered on any channel; the type only selects the template. Today every production
call site uses the default (email) and passes `toEmail`, so email is the only channel that
delivers real messages end to end (see the plumbing gap in §7).

---

## 3. Email (production-ready)

Recipient is `notification.toEmail`, which every current caller already populates, so email
is fully production-ready. `EMAIL_FROM` is the sender for both real providers.

### SendGrid

```bash
EMAIL_PROVIDER=sendgrid
EMAIL_FROM="no-reply@yourdomain.com"
SENDGRID_API_KEY="SG.xxxxxxxxxxxxxxxxxxxxxx"   # test or live key — same code
```

`SendGridEmailTransport` calls `sgMail.setApiKey(...)` once at construction and
`sgMail.send({ to, from, subject, text })` per notification.

### AWS SES v2

```bash
EMAIL_PROVIDER=ses
EMAIL_FROM="no-reply@yourdomain.com"           # must be a verified SES identity
AWS_REGION="us-east-1"
# Optional — omit to use the default AWS credential chain (IAM role / shared config):
AWS_ACCESS_KEY_ID="AKIAxxxxxxxxxxxxxxxx"
AWS_SECRET_ACCESS_KEY="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

`SesEmailTransport` sends a `SendEmailCommand` (Simple content: subject + text body). When
the explicit key pair is omitted, the SDK's default provider chain supplies credentials.
Sandbox = the SES sandbox (verified recipients only); production = request production access
in the SES console. Same code either way.

---

## 4. SMS — Twilio

```bash
SMS_PROVIDER=twilio
TWILIO_ACCOUNT_SID="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
TWILIO_AUTH_TOKEN="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
TWILIO_FROM_NUMBER="+15005550006"              # a Twilio number; test-from number for sandbox
```

`TwilioSmsTransport` reads the recipient from **`payload.phone`** (E.164) and calls
`client.messages.create({ to, from, body })`. Sandbox uses Twilio's
[test credentials and magic numbers](https://www.twilio.com/docs/iam/test-credentials);
production uses live credentials and a real sender.

> The platform does not collect phone numbers yet, so `payload.phone` is normally absent.
> In that case the transport logs a `no SMS recipient` warning and returns **without
> sending or failing** (see §7).

---

## 5. WhatsApp — Business Cloud API

```bash
WHATSAPP_PROVIDER=cloud
WHATSAPP_PHONE_NUMBER_ID="1234567890"          # from Meta; test number id for sandbox
WHATSAPP_ACCESS_TOKEN="EAAxxxxxxxxxxxxxxxx"    # temporary token in sandbox, permanent in prod
```

`CloudWhatsAppTransport` uses global `fetch` (no SDK): it POSTs to
`https://graph.facebook.com/v20.0/{WHATSAPP_PHONE_NUMBER_ID}/messages` with a Bearer token
and body:

```json
{
  "messaging_product": "whatsapp",
  "to": "<payload.phone>",
  "type": "text",
  "text": { "body": "<rendered body>" }
}
```

Recipient is **`payload.phone`** — same no-recipient skip behaviour as SMS. A non-2xx
response **throws** (with the HTTP status and Graph API error text) so the retry path runs.
Sandbox uses Meta's test phone number id + temporary token; production uses a verified
business number and a permanent token. (Note: production WhatsApp requires pre-approved
message _templates_ for business-initiated messages — this transport sends the free-form
`text` type, which suits sandbox and within-session replies.)

---

## 6. Push — Firebase Cloud Messaging (FCM)

```bash
PUSH_PROVIDER=fcm
FCM_PROJECT_ID="your-firebase-project-id"
FCM_CLIENT_EMAIL="firebase-adminsdk@your-project.iam.gserviceaccount.com"
# Escape the PEM newlines as \n on a single line:
FCM_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
```

`FcmPushTransport` initializes `firebase-admin` from those service-account fields (restoring
`\n` in the private key) under a uniquely-named app so it never collides with any other
firebase-admin init. It reads the device token(s) from **`payload.pushToken`** (single) or
**`payload.pushTokens`** (array): one token uses `messaging.send`, several use
`sendEachForMulticast` (which throws if any delivery fails). No token present → warn +
return (skip). FCM has no separate sandbox; a dev Firebase project stands in for one.

---

## 7. Recipient-plumbing gap (SMS / WhatsApp / push)

Email is production-ready because `toEmail` is a first-class field on every notification and
is always populated. **SMS, WhatsApp, and push are transport-complete but not yet fed a
recipient**, because the platform does not collect phone numbers or device tokens yet:

- **SMS / WhatsApp** need `payload.phone` (E.164).
- **Push** needs `payload.pushToken` (or `payload.pushTokens: string[]`).

Until those are collected and threaded into the `payload` at each `NotificationService.send`
/ `schedule` call site (e.g. `PaymentsService`, `RefundsService`, `CheckinsService`), the
real transports log a `no … recipient` warning and skip cleanly — they never throw and never
mark a notification `FAILED`. **The remaining step to go live on these channels** is:

1. Collect and store user phone numbers / registered device tokens.
2. Include `phone` / `pushToken(s)` in the `payload` passed to `send`/`schedule`.
3. Add the channel to the `channels` array (or to the user's enabled preferences) for the
   relevant notification types.

No change to the transports or `NotificationService` is required for that — only the payload.

---

## 8. Scheduling, retry & delivery status (unchanged)

These already exist in `NotificationService` and were **not** modified by this integration:

- **Immediate send** — `send()` resolves channels (default `['email']`, filtered by
  preferences), renders the template per channel, persists a `Notification` row with status
  `SENT`, then calls the channel's `deliver()`.
- **Scheduling** — `schedule(input, scheduledFor)` persists one `Notification` per channel
  with status `SCHEDULED` and a `scheduledFor` time, **without** delivering. `cancel(id)`
  atomically flips a still-`PENDING`/`SCHEDULED` row to `CANCELLED`. (This is the intended
  path for `EVENT_REMINDER`.)
- **Worker sweep** — the background worker (`apps/worker/src/main.ts`) runs a repeatable
  `dispatch-notifications` job every `NOTIFICATION_SWEEP_INTERVAL_MS` (default 30s) that
  calls `NotificationService.dispatchDue()`.
- **Retry & status** — `dispatchDue(now, maxAttempts = 3)` delivers each due row. On success
  the row becomes `SENT`. On error it increments `attempts`, records `lastError`, and stays
  `SCHEDULED` for a later sweep until `attempts >= maxAttempts`, at which point it is marked
  `FAILED`. Because real transports **propagate** provider errors, a failing SendGrid/Twilio/
  FCM call flows straight into this retry/`FAILED` machinery — no channel-level change needed.
  (A missing recipient is a skip, so it records as `SENT`, not `FAILED`.)

---

## 9. Testing with sandbox

- **Local (no keys):** keep every `<CHANNEL>_PROVIDER=log`. Channels log the rendered
  message exactly as before; no network, no credentials.
- **Provider sandboxes:** set the channel's provider + test credentials (SendGrid/SES test
  keys, Twilio test credentials, a Meta test WhatsApp number/token, a dev Firebase project).
- **Automated tests:** the transport unit specs
  (`apps/api/src/notifications/channels/transports/*.spec.ts`) jest-mock each SDK / global
  `fetch` — they never hit the network and cover: a successful send with the expected
  recipient/fields, provider-error propagation (so retry works), the log default staying
  log-only, the SMS/WhatsApp/push no-recipient skip, and factory selection (default `log`,
  named provider when set, fail-fast on missing keys).

> **Note:** live send verification requires real provider credentials (and, for WhatsApp/FCM,
> a registered recipient/device), so it cannot be exercised from CI or a sandbox without those
> credentials. The unit tests validate all selection, field-mapping, skip, and error-propagation
> logic offline.
