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

| Item                  | Value                                        | Status                                         |
| --------------------- | -------------------------------------------- | ---------------------------------------------- |
| Principal Entity (PE) | DeepTrics Software Solutions Private Limited | registered                                     |
| PE registration ID    | 1701179092181018311                          | registered                                     |
| Sender header         | **DPTRCS** (header ID 1705179188054799869)   | **APPROVED**                                   |
| Earlier header ETKTGO | ETKTGO                                       | **REJECTED - never configure it**              |
| Content templates     | the five below                               | **none submitted or approved yet; no ids yet** |

A header approval does not approve any template. Until a template is approved and both of its
ids are set, the platform refuses to send that kind of SMS (section 4).

The API refuses to boot, when MSG91 carries SMS, if `DLT_SENDER_HEADER` or `MSG91_SENDER_ID` is
`ETKTGO` or is not six letters, or if any DLT id below is not 19 digits.

---

## 2. Templates to register

Register each one under header **DPTRCS**, content category **Service Implicit**, type
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
{#var#} is your ETicketsGo sign-in code. It expires in {#var#} minutes. Never share it with anyone.
```

- Variables, in order: `otp` (6 digits), `minutes` (10).
- MSG91 template content: `##otp## is your ETicketsGo sign-in code. It expires in ##minutes## minutes. Never share it with anyone.`
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

### 2.3 Booking confirmed

```text
ETicketsGo: Booking {#var#} for {#var#} on {#var#} is confirmed. Your tickets are in your email and in your account. - DeepTrics
```

- Variables, in order: `reference`, `event`, `when`.
- Env: `MSG91_SMS_TEMPLATE_BOOKING_CONFIRMED`, `DLT_TEMPLATE_ID_BOOKING_CONFIRMED`

### 2.4 Booking cancelled

```text
ETicketsGo: Booking {#var#} is cancelled. Check your email for refund details. - DeepTrics
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

1. Link MSG91 to the PE as its telemarketer on the DLT portal (PE-TM chain).
2. Add header DPTRCS to the MSG91 account.
3. For each approved template: SMS > Templates > add, paste the DLT text with each `{#var#}`
   written as `##name##` using the variable names above, enter the DLT template ID, choose
   sender DPTRCS. MSG91 then shows its own template id.
4. Delivery reports: set the DLR webhook to
   `https://<api host>/api/notifications/webhooks/msg91/<MSG91_WEBHOOK_SECRET>`.

The platform calls MSG91's v5 flow API (`/api/v5/flow`). A flow request has no route
parameter; the route is the template's (transactional/service).

---

## 4. Configuration (names only - set values out of band)

| Env var                                | What it holds                                                 |
| -------------------------------------- | ------------------------------------------------------------- |
| `SMS_PROVIDER_BY_MARKET`               | `IN=msg91` (keep `NOTIFICATION_MARKETS` consistent)           |
| `SMS_ENABLED`                          | `true` only when the steps on this page are done              |
| `MSG91_AUTH_KEY`                       | secret; sent as a header, never logged                        |
| `DLT_SENDER_HEADER`                    | `DPTRCS`                                                      |
| `MSG91_SENDER_ID`                      | `DPTRCS` (must equal `DLT_SENDER_HEADER`, or boot is refused) |
| `DLT_PRINCIPAL_ENTITY_ID`              | the 19-digit PE ID                                            |
| `MSG91_WEBHOOK_SECRET`                 | secret, 32+ random characters, in the DLR URL                 |
| `MSG91_SMS_TEMPLATE_OTP`               | MSG91 template id for 2.1                                     |
| `DLT_TEMPLATE_ID_OTP`                  | 19-digit DLT template ID for 2.1                              |
| `MSG91_SMS_TEMPLATE_SHOW_CANCELLED`    | MSG91 template id for 2.2                                     |
| `DLT_TEMPLATE_ID_SHOW_CANCELLED`       | 19-digit DLT template ID for 2.2                              |
| `MSG91_SMS_TEMPLATE_BOOKING_CONFIRMED` | MSG91 template id for 2.3 (optional)                          |
| `DLT_TEMPLATE_ID_BOOKING_CONFIRMED`    | 19-digit DLT template ID for 2.3 (optional)                   |
| `MSG91_SMS_TEMPLATE_BOOKING_CANCELLED` | MSG91 template id for 2.4 (optional)                          |
| `DLT_TEMPLATE_ID_BOOKING_CANCELLED`    | 19-digit DLT template ID for 2.4 (optional)                   |
| `MSG91_SMS_TEMPLATE_REFUND_COMPLETED`  | MSG91 template id for 2.5 (optional)                          |
| `DLT_TEMPLATE_ID_REFUND_COMPLETED`     | 19-digit DLT template ID for 2.5 (optional)                   |

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
- **Delivery status.** For notifications, the MSG91 DLR updates the `NotificationDelivery` row
  (delivered, failed, DND-blocked, and so on) and suppresses a DND or blocked number. A
  sign-in code has no notification row by design, so its DLR is held unmatched; match it by
  the logged request id.

---

## 5. Switch-on checklist

1. Templates 2.1 and 2.2 approved on the DLT portal (3-5 optional).
2. Each added in MSG91 under DPTRCS with the variable names above.
3. Set the section 4 keys on the environment. Do not set `OTP_SMS_TEMPLATE`.
4. Readiness for IN shows SMS with no `BLOCKED_DLT` gap.
5. Add an SMS rate row so messages are costed.
6. One real sign-in code to a Jio, an Airtel and a Vi number held by the team. Confirm the
   wording and the DLR. Only then set `SMS_ENABLED=true` for customers or advertise phone sign-in.
