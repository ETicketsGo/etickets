# India DLT / SMS template inventory

> **Superseded for template texts and configuration.** The exact wording to register, the
> variables, the header (DPTRCS, approved; ETKTGO, rejected) and the env keys now live in
> [notifications/INDIA-DLT-TEMPLATES.md](notifications/INDIA-DLT-TEMPLATES.md), which a unit
> test keeps identical to the code. This page keeps the history and the failure behaviour.

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

## 2. Configuration

See [notifications/INDIA-DLT-TEMPLATES.md](notifications/INDIA-DLT-TEMPLATES.md) section 4.

What changed on 2026-10-14 (branch `fix/india-sms-dlt-readiness`): the MSG91 transport used to
send the whole rendered message as one variable (`MSG91_SMS_BODY_VAR`), fall back to one shared
id for every type (`MSG91_SMS_TEMPLATE_ID`), and pass any `payload.smsTemplateVars`. None of
those can match a DLT approval, so all three are gone and the two keys are refused at boot when
MSG91 carries SMS. Each kind now needs its own registered wording plus two ids
(`MSG91_SMS_TEMPLATE_<KIND>`, `DLT_TEMPLATE_ID_<KIND>`), or it is refused without calling MSG91.

---

## 3. The messages

### 3.1 Sign-in OTP

Sent by `PhoneOtpService` with `type: 'ACCOUNT_SECURITY'` (not a `NotificationType`). It
bypasses `NotificationService` on purpose: a code is a credential with a ten-minute life and
must not be written into a queryable `Notification` row. Leave `OTP_SMS_TEMPLATE` unset; its
default is the registered text.

**Rate limits already implemented:** 10-minute expiry, max 5 verification attempts per code
(compare-and-increment, so a race cannot buy extra guesses), max 5 sends per hour per number,
codes stored as bcrypt hashes. On a send failure the OTP row is consumed, so **a code nobody
received is not redeemable**.

### 3.2 Notifications

Policy (`notification-policy.ts`) sends exactly one notification type by SMS:
`SHOW_CANCELLED`, as a fallback 30 minutes after the first send when nothing else got through.
The earlier version of this table listed twelve types as "DLT needed"; that overstated it.
Booking confirmed, booking cancelled and refund sent have registered wording too, so they can be
approved ahead of any decision to send them by SMS; that decision is a policy change.

> **Warning on `GUEST_BOOKING_ACCESS`.** Its payload carries a bearer access link. An SMS is a
> locked-screen notification, so it has no SMS template and must not get one without a
> deliberate decision.

### 3.3 Organizer and admin messages

Email-first. Organizers sign in by email and password. No SMS template is registered for them.

### 3.4 Marketing

**None.** No promotional SMS template exists and none should be registered as part of this work.

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

1. **DLT registration** — done: PE ID recorded, header DPTRCS approved (ETKTGO rejected).
2. **An MSG91 account** with the India SMS route enabled.
3. **The approved templates** in notifications/INDIA-DLT-TEMPLATES.md, and both ids for each.
4. A decision on `GUEST_BOOKING_ACCESS` (bearer link by SMS: yes or no).

Then set the keys in notifications/INDIA-DLT-TEMPLATES.md section 4.

`ALLOW_UNDELIVERABLE_NOTIFICATIONS` can be removed only once every channel the platform
expects is deliverable — not as part of enabling SMS alone.
