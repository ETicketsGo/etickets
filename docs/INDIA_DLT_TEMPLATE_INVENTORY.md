# India DLT / SMS template inventory

What ETicketsGo sends by SMS in India, with the real wording and the real configuration keys —
usable when registering templates on a DLT portal and when configuring MSG91.

Read from source at `main = c77a9cd`. **No template is invented here.** Where a message has no
SMS body today, it says so.

---

## 1. State of play

Nothing can reach an Indian phone right now. `SMS_PROVIDER` defaults to `log`, and production
holds **no** `TWILIO_*` and **no** `MSG91_*` credentials. `ALLOW_UNDELIVERABLE_NOTIFICATIONS`
is set, which is what lets the API boot in that state.

The consequence worth stating first: **phone sign-in cannot work in production.**
`POST /auth/phone/request-code` sends an SMS, there is no transport, and the platform is
phone-first for India. A buyer choosing the phone route reaches a code-entry screen for a code
that was never sent.

---

## 2. Configuration the application already expects

These are the actual names. None has a default, deliberately: an approved template id belongs
to a DLT registration, and a hardcoded one is either wrong or somebody else's.

### Provider selection

| Key                      | Values                       | Note                                                           |
| ------------------------ | ---------------------------- | -------------------------------------------------------------- |
| `SMS_PROVIDER`           | `log` \| `twilio` \| `msg91` | defaults to `log`                                              |
| `SMS_PROVIDER_BY_MARKET` | e.g. `IN=msg91,US=twilio`    | per-market override; leave unset to use the single value above |

### MSG91 (the India path)

| Key                                | What it is                                                                   |
| ---------------------------------- | ---------------------------------------------------------------------------- |
| `MSG91_AUTH_KEY`                   | account key; sent as the `authkey` header, never logged                      |
| `MSG91_SENDER_ID`                  | the sender/header string                                                     |
| `MSG91_BASE_URL`, `MSG91_SMS_PATH` | endpoint                                                                     |
| `MSG91_TIMEOUT_MS`                 | defaults to 10000                                                            |
| `MSG91_SMS_TEMPLATE_IDS`           | legacy per-type map: `BOOKING_CONFIRMED=<dlt_id>,BOOKING_CANCELLED=<dlt_id>` |
| `MSG91_SMS_TEMPLATE_ID`            | fallback id for types not named above                                        |
| `MSG91_SMS_BODY_VAR`               | the variable in the approved template that receives the rendered message     |
| `MSG91_WEBHOOK_SECRET`             | path secret in the delivery-report URL                                       |

### DLT registration facts

| Key                       | What it is                                                                                |
| ------------------------- | ----------------------------------------------------------------------------------------- |
| `DLT_PRINCIPAL_ENTITY_ID` | the PE ID from the DLT portal                                                             |
| `DLT_SENDER_HEADER`       | the registered header. **Startup checks it matches `MSG91_SENDER_ID`** and refuses if not |

### The canonical binding (prefer this over the legacy map)

```
NOTIFICATION_TEMPLATE_BINDINGS=msg91:sms:<TYPE>:<locale>=<dlt_template_id>
```

`<locale>` may be `*`. With no binding and no fallback the transport raises a **permanent**
`TEMPLATE_NOT_FOUND` failure naming the exact key to set — it does not retry, and it does not
guess. A missing registration shows up as a visible FAILED row, not as messages the carrier
quietly drops.

### Two template shapes are supported

- **Single variable** — the whole rendered message goes into `MSG91_SMS_BODY_VAR`. Register a
  template whose approved wording is one variable.
- **Named slots** — if the caller supplies `payload.smsTemplateVars`, those are sent instead,
  so a template like `Your booking ##ref## is confirmed` works.

Which to register is your account's business; the code does not care.

---

## 3. The messages

### 3.1 Sign-in OTP — the only one with its own wording

|                        |                                                                                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Trigger                | `POST /auth/phone/request-code`, `/auth/phone/verify`, and the attach-phone pair                                                                        |
| Template key for MSG91 | **`ACCOUNT_SECURITY`** — the OTP path sends with `type: 'ACCOUNT_SECURITY'`, which is **not** a `NotificationType`. Bind `msg91:sms:ACCOUNT_SECURITY:*` |
| Configurable body      | `OTP_SMS_TEMPLATE`                                                                                                                                      |
| Current default        | `{code} is your ETicketsGo sign-in code. It expires in {minutes} minutes. Never share it with anyone.`                                                  |
| Variables              | `{code}`, `{minutes}` (always 10)                                                                                                                       |
| DLT registration       | **Required**                                                                                                                                            |

This one bypasses `NotificationService` on purpose: a code is a credential with a ten-minute
life and must not be written into a queryable `Notification` row. It is also the reason
`OTP_SMS_TEMPLATE` is configuration — TRAI requires the text to match the registered template,
and an operator silently drops anything that differs, so a compliance correction must not need
a deploy.

**Rate limits already implemented:** 10-minute expiry, max 5 verification attempts per code
(compare-and-increment, so a race cannot buy extra guesses), max 5 sends per hour per number,
codes stored as bcrypt hashes. On a send failure the OTP row is consumed, so **a code nobody
received is not redeemable** — there is no path to a successful phone auth without delivery.

### 3.2 Transactional messages that would go by SMS

These render **one shared body** from the `@eticketsgo/i18n` catalogue, used by email and SMS
alike. So the DLT-registered wording must either be a single-variable container, or match the
catalogue string for that type and locale.

| `NotificationType`         | Trigger                              | DLT needed      | Template id configured? |
| -------------------------- | ------------------------------------ | --------------- | ----------------------- |
| `BOOKING_CONFIRMED`        | payment captured → booking CONFIRMED | Yes             | No                      |
| `PAYMENT_FAILED`           | `payment.failed`, one per booking    | Yes             | No                      |
| `BOOKING_CANCELLED`        | buyer or organizer cancels           | Yes             | No                      |
| `SHOW_CANCELLED`           | organizer cancels a show             | Yes             | No                      |
| `SHOW_CHANGED`             | show time/venue changed              | Yes             | No                      |
| `REFUND_REQUESTED`         | refund raised                        | Yes             | No                      |
| `REFUND_COMPLETED`         | refund settled                       | Yes             | No                      |
| `EVENT_REMINDER`           | before the show                      | Yes             | No                      |
| `TICKET_CHECKED_IN`        | gate scan                            | Probably        | No                      |
| `TICKET_TRANSFERRED`       | ticket passed on                     | Probably        | No                      |
| `GUEST_BOOKING_ACCESS`     | guest purchase access link           | **See warning** | No                      |
| `PASSWORD_RESET_REQUESTED` | reset requested                      | Yes             | No                      |

**None has a template id configured anywhere today.** Every row above is a registration you
need before that message can be delivered in India.

> **Warning on `GUEST_BOOKING_ACCESS`.** Its payload carries a bearer access link. The email
> template deliberately keeps that link out of the subject line because a subject shows on a
> locked screen. An SMS _is_ a locked-screen notification, so routing this type to SMS puts a
> bearer credential on a lock screen. Decide deliberately before registering it.

### 3.3 Organizer and admin messages

`ORGANIZATION_REGISTERED/APPROVED/REJECTED`, `EVENT_SUBMITTED/APPROVED/REJECTED`,
`EVENT_NOT_SELLABLE`, `PAYOUT_ACCOUNT_UPDATED`, `SETTLEMENT_RELEASED`,
`PAYMENT_DISPUTE_OPENED/CLOSED`, `TRANSFER_FAILED`, `PASSWORD_CHANGED`, the `ATTENDEE_*` and
`SHARE_*` families.

These reach organizers and staff rather than ticket buyers. **There is no separate organizer
OTP**: organizers authenticate through the same `/auth/phone/*` endpoints, so §3.1 covers them.
Registering these for SMS is optional — they are email-first today.

### 3.4 Marketing

**None.** `MESSAGE_CLASS` classifies every type, and a `MARKETING` message requires a recorded
affirmative consent before it can be sent at all. No promotional SMS template exists and none
should be registered as part of this work.

---

## 4. Failure behaviour, as implemented

| Risk                                               | What actually happens                                                                                                                                              |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phone auth succeeds without an OTP being delivered | **Cannot.** A send failure consumes the OTP row, so the undelivered code is not redeemable.                                                                        |
| Ticket lost because SMS failed                     | **No.** The confirmation notification is queued inside the confirming transaction; delivery is separate. A failed SMS cannot un-issue a ticket.                    |
| Booking rolled back after successful payment       | **No.** Confirmation is atomic and does not depend on any notification succeeding.                                                                                 |
| Duplicate SMS storms                               | Bounded: `PAYMENT_FAILED` uses `intentKey: payment-failed:<bookingId>` so it is one per booking however many attempts fail; OTP sends are capped at 5/hour/number. |
| Infinite retries                                   | No. `TEMPLATE_NOT_FOUND` is classified permanent and is not retried.                                                                                               |
| OTP codes in logs                                  | Only where `messageContentLoggable` allows it (LOCAL/DEV). Outside those the code reaches neither log, response nor audit row.                                     |

**Email fallback: there is none, and none should be invented.** If SMS cannot deliver, the OTP
simply is not delivered — phone sign-in is unavailable, and email/password sign-in is the
separate route that still works. Nothing in the code silently emails a code instead, and adding
that would move a credential to a different channel than the one the user chose.

---

## 5. What you need to obtain

1. **DLT registration** — PE ID and a registered sender header (long lead; external).
2. **An MSG91 account** with the India SMS route enabled.
3. **One approved template per row in §3.2 plus `ACCOUNT_SECURITY`**, and their ids.
4. A decision on `GUEST_BOOKING_ACCESS` (bearer link by SMS: yes or no).

Then set: `SMS_PROVIDER=msg91` (or `SMS_PROVIDER_BY_MARKET=IN=msg91`), `MSG91_AUTH_KEY`,
`MSG91_SENDER_ID`, `DLT_SENDER_HEADER` (identical to the sender id), `DLT_PRINCIPAL_ENTITY_ID`,
`MSG91_SMS_BODY_VAR`, and one `NOTIFICATION_TEMPLATE_BINDINGS` entry per template.

`ALLOW_UNDELIVERABLE_NOTIFICATIONS` can be removed only once every channel the platform
expects is deliverable — not as part of enabling SMS alone.
