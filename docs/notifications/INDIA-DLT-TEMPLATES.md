# India DLT SMS templates (source of truth)

What to register on the DLT portal, and what to set once it is approved, so that configuration
alone turns India SMS on. This page is the owner copy of
`apps/api/src/notifications/templates/dlt-sms-templates.ts`. A unit test
(`dlt-sms-templates.spec.ts`) fails if the two differ, so the text below is the text that is
sent.

Other India pages link here rather than repeating it:
`docs/INDIA_DLT_TEMPLATE_INVENTORY.md` (history and message inventory),
`docs/pilot/INDIA-COMMUNICATIONS.md` (pilot posture),
`docs/notifications/EXTERNAL-SETUP-CHECKLIST.md` (all providers).

Nothing on this page is a secret. No template id appears in the repository, and none should.

---

## 1. Registration facts (public, supplied by the owner)

**Owner statement, 2026-10-25 (authoritative):** "ETicketsGo's India MSG91 PE-TM chain, ETKTGO
header and eight templates are already approved. Do not classify those approvals as pending."
This replaces the earlier record (2026-10-14) that the portal had rejected ETKTGO.

| Item                  | Value                                        | Status                                             |
| --------------------- | -------------------------------------------- | -------------------------------------------------- |
| Principal Entity (PE) | DeepTrics Software Solutions Private Limited | registered                                         |
| PE registration ID    | 1701179092181018311                          | registered                                         |
| PE-TM chain (MSG91)   | PE linked to MSG91 as telemarketer           | **APPROVED** (owner, 2026-10-25)                   |
| Sender header         | **ETKTGO** (header ID 1705179235688275119)   | **APPROVED** (owner, 2026-10-25)                   |
| Sender header         | **DPTRCS** (header ID 1705179188054799869)   | **APPROVED** (earlier; still accepted by the code) |
| Content templates     | eight (section 1.1)                          | **APPROVED** (owner, 2026-10-28 ids in 1.1)        |

A header approval does not approve any template, and a template is approved under ONE header.
Configure the header the eight templates are linked to. Until a kind has both of its ids set,
the platform refuses to send that kind of SMS and never calls MSG91 (section 4).

The API refuses to boot, when MSG91 carries SMS, if `DLT_SENDER_HEADER` or `MSG91_SENDER_ID` is
not six letters, if the two differ, if either is a header in `REJECTED_SENDER_HEADERS` (empty
today; kept so a future rejection is one line in `dlt-sms-templates.ts`), or if any DLT id below
is not 19 digits. ETKTGO and DPTRCS are both accepted.

### 1.1 The eight approved templates (owner, 2026-10-28)

The DLT ids are pinned in `dlt-sms-templates.ts` (`approved.dltTemplateId`) as a CHECK only:
the value sent is still read from `DLT_TEMPLATE_ID_<KIND>`, and a configured id that differs
from the approved one is refused. MSG91's own template ids (24 hex, the flow API's
`template_id`) are a different thing and are never replaced by a DLT id. MSG91 has no read-only
API that lists them, so copy each one from the MSG91 dashboard (SMS > Templates) into
`MSG91_SMS_TEMPLATE_<KIND>`. The MSG91 auth key used is named "ETGProdSMS" in MSG91.

| Approved template    | DLT id              | Kind in code               | DLT id key                          | MSG91 id key                           | Text verified | Trigger                                |
| -------------------- | ------------------- | -------------------------- | ----------------------------------- | -------------------------------------- | ------------- | -------------------------------------- |
| Login OTP            | 1777179239436687127 | `ACCOUNT_SECURITY`         | `DLT_TEMPLATE_ID_OTP`               | `MSG91_SMS_TEMPLATE_OTP`               | **yes**       | phone sign-in                          |
| Password Reset       | 1777179240353412789 | `PASSWORD_RESET_REQUESTED` | `DLT_TEMPLATE_ID_PASSWORD_RESET`    | `MSG91_SMS_TEMPLATE_PASSWORD_RESET`    | **yes**       | exists; policy sends email only        |
| Password Change      | 1777179240360916280 | `PASSWORD_CHANGED`         | `DLT_TEMPLATE_ID_PASSWORD_CHANGE`   | `MSG91_SMS_TEMPLATE_PASSWORD_CHANGE`   | **yes**       | exists; policy sends email only        |
| Password Update      | 1777179239457786914 | `PASSWORD_UPDATE`          | `DLT_TEMPLATE_ID_PASSWORD_UPDATE`   | `MSG91_SMS_TEMPLATE_PASSWORD_UPDATE`   | **no**        | not implemented                        |
| Booking Confirmation | 1777179239474119451 | `BOOKING_CONFIRMED`        | `DLT_TEMPLATE_ID_BOOKING_CONFIRMED` | `MSG91_SMS_TEMPLATE_BOOKING_CONFIRMED` | **yes**       | exists; policy sends no SMS            |
| Booking Cancellation | 1777179239566169492 | `BOOKING_CANCELLED`        | `DLT_TEMPLATE_ID_BOOKING_CANCELLED` | `MSG91_SMS_TEMPLATE_BOOKING_CANCELLED` | **yes**       | exists; policy sends no SMS            |
| Payment Pending      | 1777179239515564360 | `PAYMENT_PENDING`          | `DLT_TEMPLATE_ID_PAYMENT_PENDING`   | `MSG91_SMS_TEMPLATE_PAYMENT_PENDING`   | **yes**       | not implemented (no notification type) |
| Event Reminder       | 1777179240387088578 | `EVENT_REMINDER`           | `DLT_TEMPLATE_ID_EVENT_REMINDER`    | `MSG91_SMS_TEMPLATE_EVENT_REMINDER`    | **yes**       | show-reminder job; policy sends no SMS |

### Registered in MSG91 (read back 2026-10-29)

Each row was read from MSG91 (`getTemplateVersions`): DLT-verified, sender ETKTGO, DLT id
matching the table above. The MSG91 template id is not a secret; it is set as
`MSG91_SMS_TEMPLATE_<KIND>`. Password Update is approved on DLT but **not added in MSG91**,
so it cannot send.

| Template             | MSG91 template id        | Registered wording (MSG91 variables)                                                                                        |
| -------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Login OTP            | 6ae2c05f95642b7a550d6c32 | Your ETicketsGo verification code is ##num##. Valid for 5 minutes. Do not share this code.                                  |
| Password Reset       | 6ae2c1b46655943701016402 | Your ETicketsGo password reset code is ##num##. Valid for 5 minutes. Do not share this code.                                |
| Password Change      | 6ae2c2246b90591b2a0196e2 | Your ETicketsGo password was changed successfully. If this was not you, contact our support team immediately.               |
| Booking Confirmation | 6ae2c2af9aa037348c0f8612 | ETicketsGo: Your booking ##alp1## for ##alp2## on ##alp3## is confirmed. View your ticket in your account.                  |
| Booking Cancellation | 6ae2c278b17dc355cf032122 | ETicketsGo: Your booking ##alp1## for ##alp2## has been cancelled. Check your account for refund details, if applicable.    |
| Payment Pending      | 6ae2c4bceee4c4ebcf0cb723 | ETicketsGo: Your booking ##alp## is awaiting payment confirmation. Check your booking status before making another payment. |
| Event Reminder       | 6ae2c31a5da0579e850ca872 | ETicketsGo: Reminder! Your event ##alp1## is scheduled for ##alp2##. Please carry your ticket QR code for entry.            |
| Password Update      | (not in MSG91)           | -                                                                                                                           |

DLT form (each `{#var#}` is one variable) of the templates not shown in section 2:

```text
Your ETicketsGo password reset code is {#var#}. Valid for 5 minutes. Do not share this code.
Your ETicketsGo password was changed successfully. If this was not you, contact our support team immediately.
ETicketsGo: Your booking {#var#} is awaiting payment confirmation. Check your booking status before making another payment.
ETicketsGo: Reminder! Your event {#var#} is scheduled for {#var#}. Please carry your ticket QR code for entry.
```

The sign-in text says "Valid for 5 minutes"; a code is accepted for `OTP_TTL_MINUTES` (10) in
`auth/phone-otp.service.ts`. Owner decision: keep 10, or shorten to 5 to match the wording.

**Text verified = no** means the registered wording and its variables could not be read back
from MSG91, so the kind is refused (never sent) until somebody copies the exact registered text
and variable names, in order, into `dlt-sms-templates.ts` and sets `textVerified: true`. The
wording in section 2 is what the code expected to register; it is not proof of what was.

Kinds with **no** approved template are never sent by MSG91, whatever ids are set; their
readers get email only: `SHOW_CANCELLED` (`DLT_TEMPLATE_ID_SHOW_CANCELLED`,
`MSG91_SMS_TEMPLATE_SHOW_CANCELLED`), `SHOW_CANCELLED_ONLINE`
(`DLT_TEMPLATE_ID_SHOW_CANCELLED_ONLINE`, `MSG91_SMS_TEMPLATE_SHOW_CANCELLED_ONLINE`),
`SHOW_CANCELLED_CASH` (`DLT_TEMPLATE_ID_SHOW_CANCELLED_CASH`,
`MSG91_SMS_TEMPLATE_SHOW_CANCELLED_CASH`) and `REFUND_COMPLETED`
(`DLT_TEMPLATE_ID_REFUND_COMPLETED`, `MSG91_SMS_TEMPLATE_REFUND_COMPLETED`). ("pack A/B" are in
[INDIA-DLT-SHOW-CANCELLED-REPLACEMENT.md](INDIA-DLT-SHOW-CANCELLED-REPLACEMENT.md).)

Set `DLT_SENDER_HEADER` and `MSG91_SENDER_ID` to `ETKTGO`, and `DLT_PRINCIPAL_ENTITY_ID` to the
PE ID above.

---

## 2. Template wording (what the code sends)

The owner reports eight templates approved (section 1.1). The wording below is what the code
sends for each kind; it must match the approved text exactly. Each is under the configured header
(**ETKTGO**, per the owner's 2026-10-25 statement; DPTRCS is also accepted), content category **Service Implicit**, type
**Transactional (service)**. None is promotional. Every `{#var#}` is one DLT variable (at most
30 characters; the platform shortens long event titles with "..." and refuses anything else that
would not fit). Copy each text exactly: one changed character, space or full stop and the
operator drops the message.

| #   | Kind               | Needed for                    | Policy sends it by SMS today?                                          |
| --- | ------------------ | ----------------------------- | ---------------------------------------------------------------------- |
| 1   | Sign-in code (OTP) | phone sign-in                 | **yes - required**                                                     |
| 2   | Show cancelled     | SMS fallback after 30 minutes | **yes - required**                                                     |
| 3   | Booking confirmed  | -                             | no (email, app, push, WhatsApp). Optional: register now for later use. |
| 4   | Booking cancelled  | -                             | no (email, app, push). Optional.                                       |
| 5   | Refund sent        | -                             | no (email, app, push, WhatsApp). Optional.                             |

Registering 3-5 now costs nothing and means a later decision to send them by SMS needs no new
approval. Sending them by SMS is a product decision in `notification-policy.ts`, not a
configuration change.

### 2.1 Sign-in code (OTP)

```text
Your ETicketsGo verification code is {#var#}. Valid for 5 minutes. Do not share this code.
```

- Variables, in order: `otp` (6 digits), `minutes` (10).
- MSG91 template content: `Your ETicketsGo verification code is ##num##. Valid for 5 minutes. Do not share this code.`
- Env: `MSG91_SMS_TEMPLATE_OTP`, `DLT_TEMPLATE_ID_OTP`
- Leave `OTP_SMS_TEMPLATE` **unset**. Its default is this exact text; a different value makes
  the API refuse to boot when MSG91 carries SMS.

### 2.2 Show cancelled

```text
ETicketsGo: {#var#} on {#var#} is cancelled. Booking {#var#}. Check your email for refund details. - DeepTrics
```

- Variables, in order: `event` (title, up to 30 characters), `when` (`01 Nov 2026, 07:00 PM`
  in the venue's time zone), `reference` (`ETG-IN-2026-000042`).
- Env: `MSG91_SMS_TEMPLATE_SHOW_CANCELLED`, `DLT_TEMPLATE_ID_SHOW_CANCELLED`
- **Being replaced.** "Check your email for refund details" is false for a buyer who paid cash
  at the counter. Two replacement templates (paid online, paid in cash) are ready to register:
  see [INDIA-DLT-SHOW-CANCELLED-REPLACEMENT.md](INDIA-DLT-SHOW-CANCELLED-REPLACEMENT.md). Until
  their ids are set, this text stays in use for online buyers and a cash buyer gets no SMS.

### 2.3 Booking confirmed

```text
ETicketsGo: Your booking {#var#} for {#var#} on {#var#} is confirmed. View your ticket in your account.
```

- Variables, in order: `reference`, `event`, `when`.
- Env: `MSG91_SMS_TEMPLATE_BOOKING_CONFIRMED`, `DLT_TEMPLATE_ID_BOOKING_CONFIRMED`

### 2.4 Booking cancelled

```text
ETicketsGo: Your booking {#var#} for {#var#} has been cancelled. Check your account for refund details, if applicable.
```

- Variables: `reference`.
- Env: `MSG91_SMS_TEMPLATE_BOOKING_CANCELLED`, `DLT_TEMPLATE_ID_BOOKING_CANCELLED`

### 2.5 Refund sent

```text
ETicketsGo: We have refunded {#var#} for booking {#var#}. Your bank may take a few working days to show it. - DeepTrics
```

- Variables, in order: `amount` (`Rs 1250.50`, from integer paise), `reference`.
- Env: `MSG91_SMS_TEMPLATE_REFUND_COMPLETED`, `DLT_TEMPLATE_ID_REFUND_COMPLETED`

All five texts are plain ASCII (no rupee sign, no curly quotes), so each stays in the GSM-7
alphabet and in one or two segments.

---

## 3. In MSG91

1. Link MSG91 to the PE as its telemarketer on the DLT portal (PE-TM chain). Approved per the
   owner, 2026-10-25.
2. Add header ETKTGO to the MSG91 account (the header the templates are linked to).
3. For each approved template: SMS > Templates > add, paste the DLT text with each `{#var#}`
   written as `##name##` using the variable names above, enter the DLT template ID, choose
   sender ETKTGO. MSG91 then shows its own template id.
4. Delivery reports: set the DLR webhook to
   `https://<api host>/api/notifications/webhooks/msg91/<MSG91_WEBHOOK_SECRET>`.

The platform calls MSG91's v5 flow API (`/api/v5/flow`). A flow request has no route
parameter; the route is the template's (transactional/service).

---

## 4. Configuration (names only - set values out of band)

| Env var                                    | What it holds                                                   |
| ------------------------------------------ | --------------------------------------------------------------- |
| `SMS_PROVIDER_BY_MARKET`                   | `IN=msg91` (keep `NOTIFICATION_MARKETS` consistent)             |
| `SMS_ENABLED`                              | `true` only when the steps on this page are done                |
| `MSG91_AUTH_KEY`                           | secret; sent as a header, never logged                          |
| `DLT_SENDER_HEADER`                        | `ETKTGO` (or `DPTRCS`: the header the templates are linked to)  |
| `MSG91_SENDER_ID`                          | same value (must equal `DLT_SENDER_HEADER`, or boot is refused) |
| `DLT_PRINCIPAL_ENTITY_ID`                  | the 19-digit PE ID                                              |
| `MSG91_WEBHOOK_SECRET`                     | secret, 32+ random characters, in the DLR URL                   |
| `SMS_TEST_RECIPIENT_ALLOWLIST`             | non-PRODUCTION only: E.164 numbers MSG91 may text; empty = none |
| `MSG91_SMS_TEMPLATE_OTP`                   | MSG91 template id for 2.1                                       |
| `DLT_TEMPLATE_ID_OTP`                      | 19-digit DLT template ID for 2.1                                |
| `MSG91_SMS_TEMPLATE_SHOW_CANCELLED`        | MSG91 template id for 2.2                                       |
| `DLT_TEMPLATE_ID_SHOW_CANCELLED`           | 19-digit DLT template ID for 2.2                                |
| `MSG91_SMS_TEMPLATE_SHOW_CANCELLED_ONLINE` | MSG91 id, show cancelled for online buyers (replacement pack)   |
| `DLT_TEMPLATE_ID_SHOW_CANCELLED_ONLINE`    | 19-digit DLT id for the same; turns that wording on             |
| `MSG91_SMS_TEMPLATE_SHOW_CANCELLED_CASH`   | MSG91 id, show cancelled for cash buyers (replacement pack)     |
| `DLT_TEMPLATE_ID_SHOW_CANCELLED_CASH`      | 19-digit DLT id for the same; turns that wording on             |
| `MSG91_SMS_TEMPLATE_BOOKING_CONFIRMED`     | MSG91 template id for 2.3 (optional)                            |
| `DLT_TEMPLATE_ID_BOOKING_CONFIRMED`        | 19-digit DLT template ID for 2.3 (optional)                     |
| `MSG91_SMS_TEMPLATE_BOOKING_CANCELLED`     | MSG91 template id for 2.4 (optional)                            |
| `DLT_TEMPLATE_ID_BOOKING_CANCELLED`        | 19-digit DLT template ID for 2.4 (optional)                     |
| `MSG91_SMS_TEMPLATE_REFUND_COMPLETED`      | MSG91 template id for 2.5 (optional)                            |
| `DLT_TEMPLATE_ID_REFUND_COMPLETED`         | 19-digit DLT template ID for 2.5 (optional)                     |

Leave unset: `OTP_SMS_TEMPLATE`. **Removed** (boot is refused if set while MSG91 carries SMS):
`MSG91_SMS_TEMPLATE_ID` (one id for every type) and `MSG91_SMS_BODY_VAR` (the whole message as
one variable). Neither can match a DLT approval. `NOTIFICATION_TEMPLATE_BINDINGS` and the legacy
`MSG91_SMS_TEMPLATE_IDS` still supply an MSG91 id, but the per-template key above wins, and the
DLT id is required either way.

### What the platform does with these

- **Fails closed.** A kind is sent only when it has registered wording, a non-rejected header
  is set, and both its ids are set (the DLT one 19 digits). Otherwise the send fails
  permanently (`TEMPLATE_NOT_FOUND` or `CONFIGURATION_ERROR`, no retries) with the exact key
  to set, and MSG91 is never called. For a sign-in code the buyer gets 503 `SMS_UNAVAILABLE`
  pointing at email.
- **Readiness** (`GET /api/admin/notifications/readiness/configuration`, market IN) reports
  `BLOCKED_DLT` and names each missing key, the sign-in code first.
- **Variables come from the registry, never the payload.** The sign-in code is matched against
  2.1 and read back out of it; a different text is refused, and the error never repeats it.
- **Logs and records.** No log line or notification row holds a sign-in code outside
  LOCAL/DEV. Phone numbers are masked (`+91***10`); MSG91 refusal text is redacted before
  it is stored. The MSG91 request id is logged on acceptance.
- **Non-production guard.** Outside `APP_ENV=PRODUCTION`, MSG91 texts only the numbers in
  `SMS_TEST_RECIPIENT_ALLOWLIST`; every other number is handled as log mode (MSG91 is not
  called). Empty or unset means MSG91 texts nobody on QA/UAT. The guard runs after the
  template checks, so QA still proves every id mapping.
- **India mobiles only.** MSG91 is called only for `+91` then ten digits starting 6-9; any
  other number fails permanently (`INVALID_DESTINATION`, no retries).
- **Delivery status.** For notifications, the MSG91 DLR updates the `NotificationDelivery` row
  (delivered, failed, DND-blocked, and so on) and suppresses a DND or blocked number. A
  sign-in code has no notification row by design, so its DLR is held unmatched; match it by
  the logged request id.

---

## 5. Switch-on checklist

1. Templates approved on the DLT portal (owner, 2026-10-25: eight approved). Confirm which is
   2.1 and 2.2 (required) and that each text matches section 2 exactly (section 1.1).
2. Each added in MSG91 under ETKTGO with the variable names above.
3. Set the section 4 keys on the environment. Do not set `OTP_SMS_TEMPLATE`.
4. Readiness for IN shows SMS with no `BLOCKED_DLT` gap.
5. Add an SMS rate row so messages are costed.
6. One real sign-in code to a Jio, an Airtel and a Vi number held by the team. Confirm the
   wording and the DLR. Only then set `SMS_ENABLED=true` for customers or advertise phone sign-in.
