# External setup checklist

Everything left, in the order it has to happen. All of it is in **somebody else's console**;
none of it can be done from this repository, and none of it has been done.

**Do not put a credential in this file.** Values go in the environment.

Verify progress with `GET /api/admin/notifications/readiness/configuration`, which reports
per market, channel and provider and returns no secrets.

---

## India — the long pole

Start here. Everything else can be done in an afternoon; this cannot.

### 1. Legal entity

- [ ] DeepTrics is registered, with GST and PAN to hand
- [ ] An authorised signatory is available — DLT registration is signed for, not clicked through

### 2. DLT registration _(days, not hours — a telecom operator is involved)_

- [ ] **Principal Entity** registered on an operator portal (Jio / Airtel / VI TrueConnect)
- [ ] **PE ID** issued → `DLT_PRINCIPAL_ENTITY_ID`
- [ ] **Sender header** registered → `DLT_SENDER_HEADER`, and it must equal `MSG91_SENDER_ID`
      _(the platform refuses to boot if the two disagree — the carrier believes the one we
      send, not the one we recorded)_
- [ ] **PE–TM linkage**: MSG91 registered as your telemarketer against the PE
- [ ] **Content templates** submitted and approved

**Only one SMS template is needed to launch.** `SHOW_CANCELLED` is the only type this
platform ever sends by SMS, and only as a fallback when nothing free got through.

Before submitting, run `GET /api/admin/notifications/readiness/templates/sms`. It reports
character count, encoding and **segment count** for the wording as it actually renders. One
non-GSM-7 character — a rupee sign, a curly quote pasted from a document — drops the segment
size from 160 characters to 70 and triples the price of every message sent under that
approval, for as long as the approval lasts. That is a decision worth making on purpose.

### 3. MSG91 account

- [ ] Account created, transactional SMS enabled → `MSG91_AUTH_KEY`
- [ ] Approved DLT template ids recorded → `NOTIFICATION_TEMPLATE_BINDINGS`
- [ ] Delivery-report URL registered:
      `https://<PUBLIC_API_URL>/api/notifications/webhooks/msg91/<MSG91_WEBHOOK_SECRET>`
- [ ] `MSG91_WEBHOOK_SECRET` generated (32+ random characters)

### 4. WhatsApp through MSG91

- [ ] WhatsApp Business account onboarded with MSG91 as the BSP
- [ ] Verified business number → `MSG91_WHATSAPP_NUMBER`
- [ ] **Five templates approved** — `BOOKING_CONFIRMED`, `SHOW_CANCELLED`, `SHOW_CHANGED`,
      `REFUND_COMPLETED`, `EVENT_REMINDER`
- [ ] Each template's **category** noted (`utility` / `authentication` / `marketing`) — they
      are priced differently and the rate card is keyed by it
- [ ] Bindings recorded in `NOTIFICATION_TEMPLATE_BINDINGS`

`GET /api/admin/notifications/readiness/templates/whatsapp` lists exactly which types need an
approval, how many variables each needs, and whether a rate exists.

### 5. Rates

- [ ] MSG91 SMS rate configured from your contract
- [ ] MSG91 WhatsApp rate configured, **per category**
- [ ] Push configured explicitly at **zero** — `CONFIGURED_FREE` is a complete answer; an
      absent rate records `UNKNOWN`, which quietly makes every total a floor

---

## Email — every market

- [ ] SES sending **domain** verified; DKIM CNAMEs published
- [ ] **SPF and DMARC** published — Gmail and Yahoo reject bulk senders without them
- [ ] **Production access granted** (out of the SES sandbox). A sandboxed account can only
      email verified addresses, so every real customer send fails. Allow a day or two.
- [ ] **Configuration set** created → `SES_CONFIGURATION_SET`
- [ ] SNS topic created; **event destination** added to the configuration set for
      `Delivery`, `Bounce`, `Complaint`, `Reject` — and **not** `Open` or `Click`
- [ ] Topic subscribed to
      `https://<PUBLIC_API_URL>/api/notifications/webhooks/ses/<SES_WEBHOOK_SECRET>`
- [ ] Subscription **confirmed in the console** (the endpoint verifies the signature and
      deliberately never auto-confirms)
- [ ] SES rate configured

> **The one that will catch you.** Without `SES_CONFIGURATION_SET`, SES publishes no events
> for the message. Mail goes out, the API returns a message id, the row says `ACCEPTED`, and
> not one callback ever arrives — with the topic configured and the subscription confirmed.

---

## United States and Canada

### Twilio — SMS

- [ ] Account and an SMS-capable sender (toll-free number, or 10DLC number)
- [ ] **Toll-free verification** approved, or **A2P 10DLC** brand and campaign registered —
      neither kind of sender reaches US/Canada without it
- [ ] **Messaging Service** created with the sender in its pool; its SID set as
      `TWILIO_MESSAGING_SERVICE_SID` on api and worker
- [ ] Messaging Service **Delivery Status Callback** set to the URL the readiness report
      prints (`<PUBLIC_API_URL>/api/notifications/webhooks/twilio`)
- [ ] `PUBLIC_API_URL` (api only) matches that URL **byte for byte** — Twilio signs the URL,
      and a mismatch fails every callback in a way indistinguishable from an attack
- [ ] Messaging Service **Incoming Messages** webhook set to
      `<PUBLIC_API_URL>/api/notifications/webhooks/twilio/inbound` (POST)
- [ ] **Advanced Opt-Out enabled** on the Messaging Service — without it Twilio still blocks
      STOPped numbers but never reports `OptOutType`, so local opt-out state cannot follow
- [ ] Geographic permissions: US and CA only
- [ ] Twilio rate configured

### Meta WhatsApp Cloud

- [ ] Meta app, WhatsApp Business Account, verified business phone number
- [ ] **Permanent** system-user access token (not a temporary one)
- [ ] `WHATSAPP_VERIFY_TOKEN` invented and entered in the Meta dashboard
- [ ] App subscribed to the **`messages`** webhook field, callback
      `https://<PUBLIC_API_URL>/api/notifications/webhooks/whatsapp/cloud`
- [ ] The same five templates approved, per locale, and bound
- [ ] Meta rate configured, per category

> Without `WHATSAPP_VERIFY_TOKEN` matching, Meta's activation fails and **no subscription
> exists at all** — the status handler is correct and simply never called.

### Push

- [ ] `PUSH_PROVIDER=expo` — this is what the mobile app registers, and it needs no credential

> `PUSH_PROVIDER=fcm` with the current app **reaches nobody**. The app registers
> `ExponentPushToken[...]`, which FCM cannot deliver to, and nothing errors.

---

## Certification

Per market and channel, once the above is done:

- [ ] `POST /api/admin/notifications/readiness/test-send` to a destination **you own** —
      never a customer's
- [ ] Row reads `sendKind=TEST`, `status=ACCEPTED`, with a `providerMessageId`
- [ ] A real callback arrives and the row reaches `DELIVERED`
- [ ] SES bounce and complaint exercised via the **AWS simulator mailboxes**, never a real
      address
- [ ] `POST /api/admin/notifications/readiness/certifications` — a named person records it

Certification **refuses** without real delivery evidence. That refusal is the feature: a
platform that can certify itself has certified nothing.

`CONTRACT_TESTED` appears without any of this. It means the adapters were proven against a
mocked provider — our side is right, and it says nothing whatsoever about theirs.

---

## Launch switches, after certification and not before

```bash
NOTIFICATION_MARKETS=IN                       # add US,CA when they are certified
NOTIFICATION_REMINDERS_ENABLED=false          # turn on deliberately
WHATSAPP_TRANSACTIONAL_OPT_IN_REQUIRED=false  # see below
```

`WHATSAPP_TRANSACTIONAL_OPT_IN_REQUIRED=true` removes WhatsApp from everyone who has not
opted in — which, before any opt-in has been collected, is everyone. Collect first, enforce
after.
