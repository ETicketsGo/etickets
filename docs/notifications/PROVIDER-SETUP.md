# Provider setup

Every step here happens in **somebody else's console**. None of it can be done from this
repository, and none of it has been done — see the status column.

Nothing on this page contains a secret. Put values in the environment, never in a file here.

**Verify each section with** `GET /api/admin/notifications/readiness/certification`, which
judges on delivery evidence rather than on whether a variable is set.

---

## Status at time of writing

| Provider            | Credentials present | Status                   |
| ------------------- | ------------------- | ------------------------ |
| Amazon SES          | ❌                  | `BLOCKED_EXTERNAL_SETUP` |
| Amazon SNS          | ❌                  | `BLOCKED_EXTERNAL_SETUP` |
| MSG91 SMS           | ❌                  | `BLOCKED_EXTERNAL_SETUP` |
| MSG91 WhatsApp      | ❌                  | `BLOCKED_EXTERNAL_SETUP` |
| Twilio              | ❌                  | `BLOCKED_EXTERNAL_SETUP` |
| Meta WhatsApp Cloud | ❌                  | `BLOCKED_EXTERNAL_SETUP` |
| FCM / Expo          | ❌                  | `BLOCKED_EXTERNAL_SETUP` |

---

## 1. Amazon SES — email, every market

### Console steps

1. **Verify the sending domain** (SES → Verified identities → Create identity → Domain).
   Publish the DKIM CNAMEs it gives you at your DNS host. Wait for `Verified`.
2. **Publish SPF and DMARC** for the same domain. Not optional at any real volume —
   Gmail and Yahoo reject bulk senders without them.
3. **Leave the sandbox** (Account dashboard → Request production access). A sandboxed
   account can only email verified addresses, so _every_ real customer send fails. Expect
   this to take a day or two.
4. **Create a configuration set** — call it `eticketsgo-notifications`.
5. **Create an SNS topic** for its events.
6. On the configuration set, **add an event destination** → SNS → the topic above, with
   these event types and **no others**:
   - `Delivery`, `Bounce`, `Complaint`, `Reject`
   - _Do not enable `Open` or `Click`._ SES offers them; a ticket email does not need a
     tracking pixel, and enabling one turns every confirmation into surveillance nobody
     asked for.
7. **Subscribe the topic** to
   `https://<PUBLIC_API_URL>/api/notifications/webhooks/ses/<SES_WEBHOOK_SECRET>` (HTTPS).
8. **Confirm the subscription in the console.** The endpoint verifies the signature and
   deliberately does **not** auto-confirm — an endpoint that confirms whatever it is offered
   attaches itself to any topic anyone points at it. Look for the log line
   `SNS SubscriptionConfirmation received and SIGNATURE-VERIFIED`.

### Environment

```bash
EMAIL_PROVIDER=ses
AWS_REGION=<region of the verified identity>
EMAIL_FROM=<verified from address>
SES_WEBHOOK_SECRET=<32+ random chars>
PUBLIC_API_URL=https://<public api host>
# Credentials come from the IAM role where one exists; otherwise:
AWS_ACCESS_KEY_ID= / AWS_SECRET_ACCESS_KEY=
SES_CONFIGURATION_SET=eticketsgo-notifications   # the name from step 4
```

**Do not skip that last one.** SES publishes events only for messages sent _with_ a
configuration set named on them. Leave it unset and everything looks fine — the mail goes out,
the API returns a message id, the row says `ACCEPTED` — and not one callback ever arrives, with
the topic configured and the subscription confirmed.

---

## 2. MSG91 — India SMS

The long pole. Budget days, not hours: DLT registration involves a telecom operator.

1. **MSG91 account**, transactional SMS enabled.
2. **DLT registration** on an operator portal (Jio/Airtel/VI TrueConnect). Register the
   _entity_, then the _header_ (sender ID), then each _template_.
3. **Approved templates.** An Indian operator drops any transactional SMS whose wording is
   not an approved template sent under a registered header. The approved wording lives at the
   operator, not in this repository.
4. Register the **delivery-report URL**:
   `https://<PUBLIC_API_URL>/api/notifications/webhooks/msg91/<MSG91_WEBHOOK_SECRET>`

Only one message type currently uses SMS, so **one approved template is enough to launch**:

| Type             | Needs a DLT template                 |
| ---------------- | ------------------------------------ |
| `SHOW_CANCELLED` | ✅ — the only SMS the platform sends |

```bash
SMS_PROVIDER_BY_MARKET=IN=msg91,US=twilio,CA=twilio
MSG91_AUTH_KEY=<auth key>
MSG91_SENDER_ID=<registered header>
MSG91_SMS_TEMPLATE_IDS=SHOW_CANCELLED=<approved template id>
MSG91_WEBHOOK_SECRET=<32+ random chars>
```

With no template configured for a type, the transport **refuses that send permanently** and
names the key to set. It does not guess, and it does not retry.

---

## 3. MSG91 — India WhatsApp

1. WhatsApp Business account onboarded **through MSG91** as the BSP.
2. A verified business number registered with them → `MSG91_WHATSAPP_NUMBER`.
3. One **approved template per type whose policy selects WhatsApp**:

| Type                  | WhatsApp template needed            |
| --------------------- | ----------------------------------- |
| `BOOKING_CONFIRMED`   | ✅                                  |
| `SHOW_CANCELLED`      | ✅                                  |
| `SHOW_CHANGED`        | ✅                                  |
| `REFUND_COMPLETED`    | ✅                                  |
| `EVENT_REMINDER`      | ✅                                  |
| `PAYMENT_FAILED`      | ❌ policy does not select WhatsApp  |
| `BOOKING_CANCELLED`   | ❌ ordinary notice, email/push only |
| `SETTLEMENT_RELEASED` | ❌ organizer, email only            |

4. **Note each template's category** (`utility` / `authentication` / `marketing`) — they are
   priced differently, and the rate row takes a `category`.

```bash
WHATSAPP_PROVIDER_BY_MARKET=IN=msg91,US=cloud,CA=cloud
MSG91_WHATSAPP_NUMBER=<E.164 without +>
MSG91_WHATSAPP_TEMPLATES=BOOKING_CONFIRMED=<name>,SHOW_CANCELLED=<name>,...
MSG91_WHATSAPP_LANGUAGE=en
```

---

## 4. Twilio — US and Canada SMS

1. Account, and a number or Messaging Service that can reach both countries.
2. **US A2P 10DLC registration** (brand + campaign). Unregistered traffic to US numbers is
   filtered by carriers.
3. Set the **Status Callback URL** to
   `https://<PUBLIC_API_URL>/api/notifications/webhooks/twilio`.
4. Check **Geographic Permissions** allows US and CA.

```bash
TWILIO_ACCOUNT_SID= / TWILIO_AUTH_TOKEN= / TWILIO_FROM_NUMBER=
PUBLIC_API_URL=https://<public api host>   # part of what Twilio signs — cannot be inferred
```

If `PUBLIC_API_URL` does not exactly match the URL Twilio calls, **every callback fails
signature verification** and looks identical to an attack.

---

## 5. Meta WhatsApp Cloud — US and Canada

1. Meta app + WhatsApp Business Account + verified business phone number.
2. A **permanent** access token (system user), not a temporary one.
3. Subscribe the app to the **`messages`** webhook field, callback
   `https://<PUBLIC_API_URL>/api/notifications/webhooks/whatsapp/cloud`, with a **verify
   token** you invent. Meta will GET that URL with the token before it activates the
   subscription, and refuse to activate until it gets the challenge back.
4. Approved templates for the same five types as above.

```bash
WHATSAPP_PHONE_NUMBER_ID= / WHATSAPP_ACCESS_TOKEN= / WHATSAPP_APP_SECRET=
WHATSAPP_VERIFY_TOKEN=<the same token you typed into the Meta dashboard>
```

If `WHATSAPP_VERIFY_TOKEN` is unset or does not match, Meta's activation fails with a
`401` and **no subscription exists at all** — the status-callback handler is then correct and
never called, because Meta never starts sending.

---

## 6. Push

Decide **one** provider. The mobile app registers `ExponentPushToken[...]`, which **FCM
cannot deliver to** — so `PUSH_PROVIDER=fcm` with the current app silently reaches nobody.

```bash
PUSH_PROVIDER=expo     # matches what the app registers; no credential needed
# or, only if the app is changed to register native FCM tokens:
PUSH_PROVIDER=fcm
FCM_PROJECT_ID= / FCM_CLIENT_EMAIL= / FCM_PRIVATE_KEY=
```

Push has **no delivery callback** on any provider. `ACCEPTED` is the terminal observable
state and certification treats it as such.

---

## 7. Rates

No prices ship. Configure one per provider/channel/market you activate, from your contracts:

```
POST /api/admin/notifications/analytics/rates    (PLATFORM_CONFIG)
```

`unitPriceMicro` is **millionths of a currency unit** — SES at $0.10/1000 is `100000` with
`billingUnit: PER_1000`. Configure push explicitly at **zero** if it is free: that records
`CONFIGURED_FREE`, which is a complete answer, where an absent rate records `UNKNOWN`, which
is not.

| Provider   | Channel  | Market | Rate source                           |
| ---------- | -------- | ------ | ------------------------------------- |
| ses        | email    | *      | `PUBLIC_RATE` — AWS pricing page      |
| msg91      | sms      | IN     | `NEGOTIATED` — your MSG91 contract    |
| msg91      | whatsapp | IN     | `NEGOTIATED`, per category            |
| twilio     | sms      | US, CA | `PUBLIC_RATE` or `NEGOTIATED`         |
| cloud      | whatsapp | US, CA | `PUBLIC_RATE`, per category           |
| expo / fcm | push     | *      | `CONFIGURED_FREE` — set it explicitly |

---

## 8. Launch flags

```bash
NOTIFICATION_REMINDERS_ENABLED=false
WHATSAPP_TRANSACTIONAL_OPT_IN_REQUIRED=false
```

Both off. Turn each on deliberately, after certification. There is no global
`NOTIFICATIONS_ENABLED` and there should not be — readiness is already per provider and per
channel, and a master switch would hide which part is actually ready.
