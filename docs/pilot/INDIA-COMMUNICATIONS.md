# India communications readiness (pilot)

Status as of 2026-10-11, read from `origin/main` at `e3e289e1`. Scope: what can reach an Indian
phone or inbox, what blocks the rest, and the configuration that is safe to run the pilot on
**today**. Pilot shape (see `PILOT-BRIEF.md`): 3-5 organizers, about 10 general-admission events,
INR through Razorpay. Production stays NO-GO.

> **Update 2026-10-14.** DLT facts from the owner: PE DeepTrics Software Solutions Private
> Limited (PE ID 1701179092181018311), header **DPTRCS APPROVED**, earlier header **ETKTGO
> REJECTED**, no content template submitted yet. Gap E1 below is **fixed** on branch
> `fix/india-sms-dlt-readiness`. The exact template texts and env keys are in
> [../notifications/INDIA-DLT-TEMPLATES.md](../notifications/INDIA-DLT-TEMPLATES.md), the
> single source of truth; section 4 below is kept for history. See section 10 for the
> email-only pilot assessment.

Evidence labels: **[code]** read from the repository at `e3e289e1`; **[test]** a spec that
passes at that commit; **[QA 2026-10-11]** an unauthenticated GET against QA today;
**[memory]** an owner note, dated, which is a lead and not a fact. Nothing here was sent to a
real phone, nothing was changed on any environment, and no credential was read.

---

## 1. Verdict

1. **No text message can reach an Indian phone, and none can until DLT is approved.** There is
   no MSG91 account, entity, header or template on record. That is an external approval; no
   engineering work shortens it.
2. **The pilot does not need text messages.** Every message a pilot buyer or organizer must get
   is guaranteed on email and the in-app inbox [code: `notification-policy.ts`]. Phone sign-in
   is the only feature that rests on SMS, and email sign-in is a complete alternative.
3. **(Fixed 2026-10-14.) The code was ready for DLT except for one real gap** (section 5, E1): the OTP and the one
   SMS-bearing notification send their whole text as a single template variable, which a DLT
   content template of the usual shape will not match. Fix before the first DLT submission.
4. **Pilot-safe configuration exists and is proved end to end** (section 8), with one honest
   caveat: there is no way to _declare_ "SMS is off on purpose", so the safe posture works by
   routing India to MSG91 with no credentials. A proper switch is engineering item E2.

---

## 2. What sends what, by channel

Policy source: `apps/api/src/notifications/policy/notification-policy.ts` [code].
"Guaranteed" means a customer preference cannot remove it.

| Event (NotificationType)                                                          | Channels allowed                                             | Guaranteed | Pilot reality (email only)                                    |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------ | ---------- | ------------------------------------------------------------- |
| `BOOKING_CONFIRMED` (the ticket)                                                  | email, in-app, push, WhatsApp                                | email, app | email + in-app                                                |
| `PAYMENT_FAILED`                                                                  | email, in-app, push                                          | email, app | email + in-app                                                |
| `BOOKING_CANCELLED` (customer's own)                                              | email, in-app, push                                          | email, app | email + in-app                                                |
| `SHOW_CANCELLED`                                                                  | email, in-app, push, WhatsApp, **SMS as 30-minute fallback** | email, app | email + in-app; SMS fallback cannot fire usefully (section 6) |
| `SHOW_CHANGED`                                                                    | email, in-app, push, WhatsApp                                | email, app | email + in-app                                                |
| `REFUND_COMPLETED`                                                                | email, in-app, push, WhatsApp                                | email, app | email + in-app                                                |
| `EVENT_REMINDER`                                                                  | in-app, push, WhatsApp (no email)                            | in-app     | **in-app only** (see note)                                    |
| `EVENT_NOT_SELLABLE`, `PAYOUT_ACCOUNT_UPDATED`, `SETTLEMENT_RELEASED` (organizer) | email, in-app                                                | email, app | email + in-app                                                |
| Any type not listed                                                               | email, in-app, push                                          | in-app     | email + in-app                                                |
| **Phone sign-in code** (not a notification type)                                  | SMS only, direct                                             | n/a        | **unavailable** (503, points at email)                        |

Facts that matter for the pilot:

- **Only two things can ever go by SMS: the sign-in code and the `SHOW_CANCELLED` fallback.** No
  other type lists SMS [code]. `docs/INDIA_DLT_TEMPLATE_INVENTORY.md` section 3.2 lists twelve
  types as "DLT needed"; that overstates it and should not drive the DLT submission. The
  minimum registration is **two content templates** (section 4).
- **Reminders reach nobody in an email-only pilot.** `EVENT_REMINDER` has no email channel by
  design (an inbox of reminders trains people to ignore the sender). With WhatsApp and push off,
  only the in-app inbox carries it. Tell pilot organizers not to rely on reminders.
- **Password reset and guest-booking access links are email** (guest checkout is an emailed
  link). They are unaffected by DLT.
- **Organizers and staff sign in by email and password**; the phone sign-in component exists
  only in customer-web [code: `apps/customer-web/components/phone-sign-in.tsx`; no phone sign-in
  in organizer-web or admin-web].
- **Marketing messages: none exist.** `MESSAGE_CLASS` marks every type, a marketing type needs a
  recorded consent, and no marketing type is defined [code: `message-class.ts`].
- Email via **AWS SES**, delivery receipts via the SNS webhook
  (`/api/notifications/webhooks/ses/<secret>`). Email is the only channel with a credible path
  today. SES state on QA was "configured, still in the SES sandbox, 200 mails/day" on
  2026-09-10 [memory: `ses-sns-webhook`]; I did not re-verify it (it needs AWS or an admin
  login). Treat **SES production access** as unconfirmed until someone checks.

---

## 3. Current state

| Environment | SMS                             | WhatsApp | Push | Email                    | Evidence                                                                                                                                                           |
| ----------- | ------------------------------- | -------- | ---- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| QA          | log mode (nothing sent)         | log      | log  | SES, sandbox             | [memory 2026-09-24 / 2026-09-10]; QA API `GET /api/health` is up [QA 2026-10-11]; readiness endpoints answer 401 without an admin login, so I did not re-read them |
| UAT         | log mode                        | log      | log  | SES or log (unconfirmed) | [memory]                                                                                                                                                           |
| PRODUCTION  | **no `TWILIO_*`, no `MSG91_*`** | none     | none | SES probable             | [memory 2026-10-04]; production variables were deliberately not read                                                                                               |

On any non-LOCAL/DEV environment, log mode is treated as "not sent": the OTP path fails closed
[code + test `otp-log-mode-is-not-sent.spec.ts`]. The 2026-10-07 incident (a production
buyer told "code sent" for a code that never existed) is closed by PR #238.

**A re-check is due before the pilot:** an admin should open
`GET /api/admin/notifications/readiness/configuration` for market IN on the pilot environment.
It reports provider state per channel with no secrets. This document's claims about QA and
production are dated and may have moved.

---

## 4. MSG91 and DLT registration

India's rule (TRAI): every commercial SMS must come from a **registered entity**, under a
**registered header**, with text matching a **registered content template** character for
character. An operator silently drops anything else. The platform therefore sends MSG91 a
_template id and variables_, never free text [code: `sms.transport.ts`, `Msg91SmsTransport`].

| Layer                 | What it is                                                                                                             | Where it lives in our config                                                                                                                | State                           |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| Principal Entity (PE) | The business (Deeptrics Software Solution Pvt Ltd per `legal.ts`) registered on an operator DLT portal; yields a PE ID | `DLT_PRINCIPAL_ENTITY_ID` (recorded for readiness; not sent on the wire)                                                                    | not started, no PE ID on record |
| Header (sender ID)    | 6-character registered sender, e.g. a branded code                                                                     | `MSG91_SENDER_ID`; `DLT_SENDER_HEADER` must equal it or the API **refuses to boot** [code: `configuration.ts` ~1439]                        | none chosen                     |
| PE-TM linkage         | MSG91 registered against the PE as the telemarketer/aggregator                                                         | none (portal step)                                                                                                                          | not started                     |
| Content templates     | Exact approved text with `{#var#}` slots; one id per template                                                          | `NOTIFICATION_TEMPLATE_BINDINGS=msg91:sms:<TYPE>:<locale>=<id>` (preferred) or legacy `MSG91_SMS_TEMPLATE_IDS` / `MSG91_SMS_TEMPLATE_ID`    | none                            |
| MSG91 account         | Auth key, India SMS route                                                                                              | `MSG91_AUTH_KEY`, `MSG91_BASE_URL`/`MSG91_SMS_PATH` (default `https://control.msg91.com` + `/api/v5/flow`)                                  | unset on QA, UAT, PROD          |
| Delivery reports      | MSG91 calls us back with status                                                                                        | `https://<api>/api/notifications/webhooks/msg91/<MSG91_WEBHOOK_SECRET>`; no published signature, so the secret in the path is the only auth | not configured                  |

**Templates to register (minimum, two):**

1. **Sign-in code.** Bind as `msg91:sms:ACCOUNT_SECURITY:*` (the OTP path sends
   `type: 'ACCOUNT_SECURITY'`, which is not a `NotificationType`). Wording comes from
   `OTP_SMS_TEMPLATE`, with `{code}` and `{minutes}` (always 10). The code default is
   `{code} is your ETicketsGo sign-in code. It expires in {minutes} minutes. Never share it with anyone.`
   The wording to register and the value of `OTP_SMS_TEMPLATE` must be identical, byte for byte.
2. **`SHOW_CANCELLED`.** The only notification with an SMS channel. Check the rendered length
   and segment count with `GET /api/admin/notifications/readiness/templates/sms` first: one
   non-GSM-7 character (a rupee sign, a curly quote) cuts the segment size from 160 to 70 and
   multiplies cost for the life of the approval [code: `docs/notifications/EXTERNAL-SETUP-CHECKLIST.md`].

**Consent template.** DLT also has a consent-registration layer (customers' consent to commercial
SMS, linked to header and entity). Whether it is required for a purely transactional/service
sender such as ours, and in what form, is decided by the operator portal and MSG91, not by
anything in this repository. **Ask MSG91 in writing and record the answer; do not assume.**
The pilot sends no promotional SMS.

**Category.** An OTP template and a cancellation template are registered in different
categories on most portals (service/OTP versus transactional). Choose on the portal; the code
does not care.

**Open risk: whole-message-as-one-variable (E1).** See section 5.

---

## 5. Engineering gaps found

| ID  | Gap                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Evidence                                                                                                                                              | Why it matters                                                                                                                                                                                                                                                                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1  | **FIXED 2026-10-14** (templates now come from `dlt-sms-templates.ts` with named variables; see INDIA-DLT-TEMPLATES.md). Was: **SMS template variables are never structured.** `Msg91SmsTransport` sends `smsTemplateVars` if the caller supplies it, otherwise the _entire rendered message_ in one variable (`MSG91_SMS_BODY_VAR`, default `body`). **No producer supplies `smsTemplateVars`** (grep over `apps/api/src`: the only reader is the transport). The OTP service passes `{ phone }` only. | [code] `sms.transport.ts` 286-288; `phone-otp.service.ts` 136-146                                                                                     | A DLT content template whose entire body is one `{#var#}` is typically rejected at registration, and a template with named slots (`Your code is {#var#}`) will not match what we send. Both OTP and `SHOW_CANCELLED` need named slots populated by the producer before DLT submission, or the first live send is dropped by the operator while MSG91 still answers "success". |
| E2  | **No way to declare "SMS off on purpose".** In STAGING/PRODUCTION the boot guard refuses SMS in log mode. The only existing bypass, `ALLOW_UNDELIVERABLE_NOTIFICATIONS=true`, also switches off the guard that refuses `EMAIL_PROVIDER=log`, so a pilot running on it could lose its email guard silently.                                                                                                                                                                                             | [code] `configuration.ts` 921-985; [memory] it is set on PROD                                                                                         | See section 8 for the interim posture. A proper fix is an explicit setting (for example a per-market SMS "disabled" provider that the guard accepts and the readiness report labels), plus a capability flag so the storefront can hide the phone tab.                                                                                                                        |
| E3  | **The phone tab is always shown and is the default.** With SMS unavailable, a pilot buyer who taps the default tab enters a number and is then told, correctly, to use email. Honest, but a wasted step.                                                                                                                                                                                                                                                                                               | [code] `login/page.tsx` line 34                                                                                                                       | Hide or demote the tab when the API reports SMS unavailable (needs E2's flag).                                                                                                                                                                                                                                                                                                |
| E4  | **A log-mode WhatsApp or push send is recorded as `SENT`** with provider `log`. For email-only operation every buyer with a phone number on file gets a `SENT/log` WhatsApp row for each confirmation.                                                                                                                                                                                                                                                                                                 | [code] `notification.service.ts` ~666 records `status: 'SENT', provider: outcome.provider`; `WhatsAppLogTransport.send` returns `{ provider: 'log' }` | Admin dashboards over-state delivery. The customer is not misled (the email is real), but anyone counting "WhatsApp sent" would be. Readiness correctly reports the channel DISABLED.                                                                                                                                                                                         |
| E5  | **MSG91 `type !== "success"` maps to `PERMANENT_REJECTION`** for every refusal, including a DLT template mismatch.                                                                                                                                                                                                                                                                                                                                                                                     | [code] `sms.transport.ts` 315                                                                                                                         | An operator reading failures cannot tell "DLT not approved" (`COMPLIANCE_BLOCKED` / `TEMPLATE_REJECTED`) from a bad number. Refine once real MSG91 error bodies are seen; do not guess the codes now.                                                                                                                                                                         |
| E6  | **The OTP path has no delivery receipt.** It bypasses `NotificationService` on purpose (a code must not be stored in a `Notification` row), so an OTP that MSG91 accepted and the operator dropped is invisible to us.                                                                                                                                                                                                                                                                                 | [code] `phone-otp.service.ts` header; [memory `phone-otp-signin`]                                                                                     | After DLT approval, run a real-handset smoke test per operator (Jio, Airtel, Vi, BSNL) before trusting phone sign-in. The MSG91 delivery report is the only other evidence, and OTP is not in it.                                                                                                                                                                             |
| E7  | **India has no SMS disclosure of its own.** The policy registry has an SMS page for `GLOBAL` and `US` only; India falls back to `GLOBAL` (the code comment says India's is "gated on DLT registration, not on text").                                                                                                                                                                                                                                                                                  | [code] `packages/shared-types/src/legal.ts` ~130-145                                                                                                  | A signup SMS-consent record in India points at the GLOBAL page. Needs an India SMS programme page (content owned by whoever is accountable for the market) before SMS is switched on.                                                                                                                                                                                         |
| E8  | **Stale or contradicting docs.** `docs/pilot/PILOT-GUIDE.md` line 44 says the platform "does not collect phone numbers" (phone sign-in and signup collect them now); `docs/INDIA_DLT_TEMPLATE_INVENTORY.md` section 3.2 lists twelve SMS types where policy allows one.                                                                                                                                                                                                                                | [code] vs docs                                                                                                                                        | Fix when next touched; not edited here to keep this PR to the new document and one test.                                                                                                                                                                                                                                                                                      |

**No code defect found in:** retry classification, suppression, OTP fail-closed behaviour,
consent recording, or the boot guards (section 6-7).

---

## 6. Delivery-failure handling

All paths below are [code] with the named specs as [test].

**Order of work.** A notification row is written in the same database transaction as the thing
it describes (booking confirmed, show cancelled, and so on). A provider failure therefore can
never un-issue a ticket or roll back a payment [code: `critical-producers.spec.ts`]. The worker
sends; the API only enqueues.

**Retries.** A retryable failure (rate limit, temporary provider error, unclassified error) is
retried on a ladder of **1 min, 5 min, 15 min, 1 h, 3 h** (six attempts in all, a little over
four hours) [code: `RETRY_DELAYS_MS`]. **Permanent failures stop at once:** missing credential,
missing route, missing DLT template, template rejected, compliance block, bad destination
[code: `isRetryableFailure`]. The row ends `FAILED` with `lastError` set; provider text that can
carry a phone number is redacted before it is stored [test: `notification.service.provider-failure.spec.ts`].

**Suppression.** A bounced/complained email, a number that opted out or is DND-blocked, is
recorded and later sends to it are refused before any provider call
[code: `suppression.service.ts`]. A transactional message to a suppressed destination fails that
channel only; other channels still go (email is guaranteed).

**Fallbacks.** The only fallback in the platform is `SHOW_CANCELLED`: SMS opens 30 minutes after
the first send **only if** no WhatsApp/push/email attempt reached `DELIVERED`/`READ` (push
counts at `ACCEPTED`). Exactly one fallback per intent, enforced by a unique key
[code: `fallback.service.ts`, test `fallback.integration-postgres.spec.ts`]. Two consequences
for the pilot:

- Email counts as "got through" only when SES reports `Delivery` through the SNS webhook. If the
  SES webhook is not subscribed, email stays at `ACCEPTED` and the SMS fallback is attempted for
  every cancelled show. With MSG91 not configured that attempt fails permanently
  (`CONFIGURATION_ERROR`) and shows as a `FAILED` SMS row. Harmless to the customer, noisy to an
  operator. Subscribe the SNS topic before the pilot (section 9, row 11).
- There is **no email fallback for a failed SMS and none should be added.** Email is already
  sent first and in parallel for every critical type.

**What each party sees.**

| Who             | Sees                                                                                                                                                                                                                                                                                                                           | Does not see                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Customer        | The ticket/cancellation/refund email and the in-app inbox entry. At sign-in, a plain sentence if the code cannot be sent ("We can't send sign-in codes by text message right now. Please sign in with your email address instead." or, for a dead/opted-out number, a deliberately identical answer so neither can be probed). | Provider names, error codes, other people's numbers                                      |
| Organizer       | Their own in-app notifications (`/organizer/notifications`).                                                                                                                                                                                                                                                                   | Customer delivery status. They are not told a buyer's email bounced; support (admin) is. |
| Admin / support | Per-notification status, attempts and failure class in the notification ops views; `GET /api/admin/notifications/readiness/*` for configuration; provider callbacks recorded in a ledger.                                                                                                                                      | Message bodies for SMS/WhatsApp outside LOCAL/DEV (content withheld by design)           |

**Gap for the pilot:** a bounced buyer email is the one failure that strands a ticket
(the in-app inbox needs a login the guest buyer may not have). Support must be able to find
`FAILED`/`BOUNCED` booking-confirmation rows daily and resend through the guest access flow
(`SUPPORT-PLAYBOOK.md`). That is a procedure, not code.

---

## 7. Customer consent and opt-out

What exists [code unless marked]:

- **Transactional messages are not gated by marketing consent**, by design: a ticket must reach
  the buyer whatever they ticked. Marketing is a separate class and none exists.
- **Consent records are append-only** (`MarketingConsent`): channel, granted/withdrawn, source
  (verbatim, server-set), IP and user agent, country, the disclosure version
  (`TYPE/JURISDICTION/vN`) and, for SMS/WhatsApp, a snapshot of the _verified_ number. A
  withdrawal is a new row. The person can read their own history (`GET /api/me/marketing-consent`).
- **At signup**, an optional SMS tick records `sms:transactional` with source `CUSTOMER_SIGNUP`
  and the number given in that request [`auth.service.ts` `recordSignupSmsConsent`]. A failure to
  record never fails the signup.
- **Opt-out channels.** Email: SES bounces/complaints suppress the address. SMS via MSG91: a
  delivery-report status of DND/blocked/unsubscribed is mapped to a rejection and suppresses the
  number [`notification-provider-status.ts`]. There is **no inbound STOP-keyword webhook for
  MSG91** (Twilio has one); India's regime handles opt-out through the DND registry and
  operator-level blocking, so STOP handling is not expected to be needed, but confirm with MSG91.
- **WhatsApp opt-in** is declared per type and enforced by `WHATSAPP_TRANSACTIONAL_OPT_IN_REQUIRED`
  (off by default; turning it on before opt-ins are collected stops all WhatsApp, because
  absence of a record means no).
- **India-specific gap:** E7 above. Also, consent evidence for SMS in India is only as good as
  the page it points at, and that page is the GLOBAL one today.

For the email-only pilot the consent position is simple: no marketing, no SMS, no WhatsApp.
Nothing needs consent that the platform does not send.

---

## 8. Pilot-safe configuration and its verification

### Recommended posture

| Setting                                  | Value                                                      | Why                                                                                                                                                                                                                 |
| ---------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EMAIL_PROVIDER`                         | `ses`, with `EMAIL_FROM`, `AWS_*`, `SES_CONFIGURATION_SET` | email is the only channel that can deliver; keep its boot guard ON                                                                                                                                                  |
| `SMS_PROVIDER_BY_MARKET`                 | `IN=msg91` (**no** `MSG91_*` credentials)                  | boots in PRODUCTION/STAGING without the escape hatch; any SMS attempt fails loudly and permanently (`CONFIGURATION_ERROR`) rather than pretending to send                                                           |
| `NOTIFICATION_MARKETS`                   | `IN`                                                       | the pilot is India only; keeps the boot guard from demanding US/CA SMS routing                                                                                                                                      |
| `SMS_ENABLED`                            | `false`                                                    | declares text messages off on purpose (E2): boots without the bypass, SMS sends fail permanently, `/capabilities` reports `phoneSignIn: false` so the login page opens on Email (E3). The email boot guard stays ON |
| `ALLOW_UNDELIVERABLE_NOTIFICATIONS`      | **unset** (remove it if set)                               | it removes the email guard too (E2)                                                                                                                                                                                 |
| `WHATSAPP_PROVIDER`, `PUSH_PROVIDER`     | leave at `log`                                             | no credentials exist; rows will read `SENT/log` (E4)                                                                                                                                                                |
| `WHATSAPP_TRANSACTIONAL_OPT_IN_REQUIRED` | unset                                                      | WhatsApp is not in use                                                                                                                                                                                              |
| `OTP_SMS_TEMPLATE`, `DLT_*`, `MSG91_*`   | unset                                                      | set together, later, with DLT approval                                                                                                                                                                              |

With `SMS_ENABLED=false` the customer login page hides the Mobile tab and opens on Email, with a
short note that text-message sign-in is not available. `SMS_ENABLED` defaults to `true`; any value
other than `true` or `false` refuses to boot. Organizer and admin sign-in are unchanged.

Sign-in for pilot users: **email and password** on customer-web (second tab), organizer-web and
admin-web. Phone sign-in answers 503 with a sentence pointing at email. Tell pilot buyers to
choose the Email tab; do not advertise phone sign-in.

### Verified end to end

| Claim                                                                | Proof                                                                                                                                                                                                            |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The posture boots in PRODUCTION without the escape hatch             | **[test, added]** `apps/api/src/auth/phone-otp.pilot-email-only.spec.ts`: `loadConfig()` with `APP_ENV=PRODUCTION`, `EMAIL_PROVIDER=ses`, `IN=msg91`, no `MSG91_*`, no hatch does not throw                      |
| It still refuses to boot if email is not real                        | same spec: `EMAIL_PROVIDER=log` throws "SENDS NOTHING"                                                                                                                                                           |
| Phone sign-in cannot claim success                                   | same spec drives the **real** `PhoneOtpService` -> `SmsChannel` -> `NotificationProviderResolver` -> `Msg91SmsTransport` (only the database mocked): 503, message contains "email address", `fetch` never called |
| An undelivered code is not redeemable                                | same spec: the last write consumes the code (`consumedAt` set)                                                                                                                                                   |
| Falsified                                                            | with `MSG91_AUTH_KEY` and a template id added to the spec's config, the 503 test fails (the chain tries to call MSG91); restored afterwards                                                                      |
| Log mode is also refused outside LOCAL/DEV (QA, UAT)                 | existing `auth/otp-log-mode-is-not-sent.spec.ts`, `config/configuration.sms.spec.ts`                                                                                                                             |
| Provider failures give two plain answers, no number or provider text | existing `auth/phone-otp.failure-isolation.spec.ts`                                                                                                                                                              |
| A provider failure cannot lose a ticket                              | existing `notifications/critical-producers.spec.ts` (critical types are written in the producing transaction)                                                                                                    |
| Every critical customer message has email guaranteed                 | `notification-policy.ts` plus `notification-policy.spec.ts`                                                                                                                                                      |

### Not verified (and why)

- **A real email reaching a real inbox from the pilot environment.** Needs SES production access
  and a live order; I did not send anything. This is the single most important pre-pilot check:
  one real order on the pilot environment, receipt arrives, SNS `Delivery` event recorded.
- **Anything on production.** By instruction, production variables were not read.
- **QA readiness values today.** The readiness endpoints need an admin login (a POST); I stayed
  to unauthenticated GETs.

---

## 9. Blocked-by table

Class: **PROVIDER** = waiting on an external approval or account (DLT portal, operator, MSG91,
Meta, AWS). **ENGINEERING** = code or docs change in this repository. **CONFIG** = a value to set
on an environment once its prerequisite exists.

| #   | Item                                                                          | Class               | Exact next action                                                                                                                                                                                                                                                           | Owner                                   |
| --- | ----------------------------------------------------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| 1   | DLT Principal Entity + PE ID                                                  | PROVIDER            | Register Deeptrics on an operator DLT portal (Jio, Airtel, Vi or BSNL TrueConnect-style portal) with GST/PAN; signatory signs. Record the PE ID.                                                                                                                            | Business owner / authorised signatory   |
| 2   | Sender header (6 chars) - **DONE: DPTRCS approved; ETKTGO rejected**          | PROVIDER            | Choose and register the header under the PE.                                                                                                                                                                                                                                | Business owner                          |
| 3   | PE-TM linkage to MSG91                                                        | PROVIDER            | Ask MSG91 for their telemarketer id; add it on the portal.                                                                                                                                                                                                                  | Business owner with MSG91               |
| 4   | Content template: sign-in code                                                | PROVIDER            | Submit text 2.1 of INDIA-DLT-TEMPLATES.md exactly; leave `OTP_SMS_TEMPLATE` unset. Record both ids.                                                                                                                                                                         | Business owner                          |
| 5   | Content template: `SHOW_CANCELLED`                                            | PROVIDER            | Submit text 2.2 of INDIA-DLT-TEMPLATES.md exactly. Record both ids.                                                                                                                                                                                                         | Business owner                          |
| 6   | Consent-template requirement                                                  | PROVIDER            | Ask MSG91 in writing whether a consent template is needed for a transactional-only sender; record the answer.                                                                                                                                                               | Business owner                          |
| 7   | MSG91 account, India SMS route, auth key                                      | PROVIDER            | Create account, enable India transactional SMS.                                                                                                                                                                                                                             | Business owner                          |
| 8   | MSG91 WhatsApp BSP onboarding + five Meta templates                           | PROVIDER            | Not needed for the pilot. Defer.                                                                                                                                                                                                                                            | Business owner                          |
| 9   | SES production access, domain verified, DKIM, SPF, DMARC                      | PROVIDER (AWS)      | Confirm `ProductionAccessEnabled` and domain status in the pilot AWS account; request production access if still sandboxed (a day or two).                                                                                                                                  | Business owner / infra                  |
| 10  | **DONE 2026-10-14** OTP + `SHOW_CANCELLED` send named template variables (E1) | ENGINEERING         | Populate `smsTemplateVars` in the OTP service and the `SHOW_CANCELLED` producer; document the slot names for the DLT submission; test with the MSG91 transport. Do this before items 4-5.                                                                                   | Notifications engineer                  |
| 11  | SES SNS event destination subscribed and confirmed                            | CONFIG              | Subscribe topic to `.../webhooks/ses/<SES_WEBHOOK_SECRET>`, confirm by hand in the AWS console, send one order, check the `Delivery` event.                                                                                                                                 | Infra                                   |
| 12  | Explicit "SMS off" setting + storefront capability flag (E2, E3)              | ENGINEERING         | Add a disabled SMS provider the boot guard accepts and readiness labels; expose availability so customer-web hides the phone tab. Until then use the section 8 posture.                                                                                                     | Notifications engineer                  |
| 13  | Remove `ALLOW_UNDELIVERABLE_NOTIFICATIONS` from the pilot environment         | CONFIG              | After row 9 is confirmed and one real email is received. Boot guard then protects email.                                                                                                                                                                                    | Infra / owner                           |
| 14  | Rows recorded `SENT` for log-mode WhatsApp/push (E4)                          | ENGINEERING         | Record log-mode as skipped, or exclude `provider=log` from sent counts. Low priority for the pilot.                                                                                                                                                                         | Notifications engineer                  |
| 15  | MSG91 refusal classification (E5)                                             | ENGINEERING         | After the first real refusals, map DLT/template errors to `COMPLIANCE_BLOCKED`/`TEMPLATE_REJECTED`.                                                                                                                                                                         | Notifications engineer                  |
| 16  | India SMS disclosure page and consent label (E7)                              | ENGINEERING + legal | Draft India SMS programme page; register it in `legal.ts`; policy owner approves wording.                                                                                                                                                                                   | Legal owner + engineer                  |
| 17  | Set MSG91 and DLT configuration                                               | CONFIG              | When rows 1-7 are done: `SMS_PROVIDER_BY_MARKET=IN=msg91`, `MSG91_AUTH_KEY`, `MSG91_SENDER_ID`, `DLT_SENDER_HEADER` (same value), `DLT_PRINCIPAL_ENTITY_ID`, `NOTIFICATION_TEMPLATE_BINDINGS`, `MSG91_WEBHOOK_SECRET`, `PUBLIC_API_URL`, `OTP_SMS_TEMPLATE`, SMS rate rows. | Infra, with secrets handled out of band |
| 18  | Real-handset OTP smoke test per operator (E6)                                 | CONFIG              | One OTP to Jio, Airtel and Vi numbers; confirm receipt and wording. Only then advertise phone sign-in.                                                                                                                                                                      | Owner + support                         |
| 19  | Support procedure for a bounced buyer email                                   | CONFIG (procedure)  | Add a daily check for `BOUNCED`/`FAILED` booking emails and the guest-link resend step to the support routine.                                                                                                                                                              | Support lead                            |
| 20  | Correct stale docs (E8)                                                       | ENGINEERING (docs)  | Fix `PILOT-GUIDE.md` line 44 and `INDIA_DLT_TEMPLATE_INVENTORY.md` section 3.2.                                                                                                                                                                                             | Docs owner                              |

### Critical path to phone sign-in in India

1 -> 2 -> 3 -> (10) -> 4 and 5 -> 7 -> 17 -> 18. External lead time is days to weeks and is
entirely outside this repository; the only engineering item on the path is row 10, and it should
start now so it is not the reason a submission waits.

### What the pilot needs from this list

Rows 9, 11 and 13 (email proven and its guard on), row 19 (a procedure), and a one-line
instruction to pilot users to sign in with email. Everything else is the path to text messages
and can follow the pilot.

---

## 10. Email-only pilot assessment (2026-10-14)

Verified by reading code at `b33f08f`, the specs named, and one read-only GET on QA. Nothing was
sent and nothing was written on QA.

**What works without SMS**

| Journey                              | Works? | Evidence                                                                                                            |
| ------------------------------------ | ------ | ------------------------------------------------------------------------------------------------------------------- |
| Customer email + password sign-in    | yes    | [code] auth service; no SMS dependency (only `/auth/phone/*` use `PhoneOtpService`)                                 |
| Guest checkout                       | yes    | [code] `bookings/guest-booking.service.ts`: emailed access link, no phone or SMS step                               |
| Organizer and admin sign-in          | yes    | email + password; no phone sign-in in organizer-web or admin-web                                                    |
| Ticket, cancellation, refund notices | yes    | email and in-app are guaranteed for every critical type (`notification-policy.ts`)                                  |
| Phone OTP sign-in                    | **no** | 503 `SMS_UNAVAILABLE` pointing at email [test: `phone-otp.pilot-email-only.spec.ts`, `phone-otp.msg91-dlt.spec.ts`] |
| `SHOW_CANCELLED` SMS fallback        | no     | refused permanently (`TEMPLATE_NOT_FOUND`/`CONFIGURATION_ERROR`), a FAILED SMS row; email already went              |

**QA today (read-only GET `/api/capabilities`, 2026-10-14):** `phoneSignIn: true`, so QA still
shows the Mobile tab, and by code and test a code request there gets 503 `SMS_UNAVAILABLE` (log mode is not
a send outside LOCAL/DEV). The POST was not made because it writes a code row. For the pilot set
`SMS_ENABLED=false` so the storefront opens on Email.

**Legal and operational limits for an email-only pilot**

1. **No sale-critical information only by SMS.** Nothing is today: every critical type has email
   and in-app guaranteed. Keep it that way; do not add an SMS-only message.
2. **A bounced email is the one stranded-ticket failure.** Support checks FAILED/BOUNCED booking
   emails daily and resends via the guest access flow (section 6).
3. **Do not advertise phone sign-in** or "we will text you" anywhere (event pages, organizer
   briefings, receipts) until a real handset receives a code from each major operator.
4. **No SMS, no WhatsApp, no marketing** means no SMS consent is collected for use. The signup
   SMS tick still records consent against the GLOBAL disclosure (E7); that record is evidence
   of consent, not permission to send promotional SMS. Fix E7 before SMS goes live.
5. **Event reminders reach only the in-app inbox** (no email channel by design). Tell organizers.
6. **SES must be out of the sandbox** and its SNS delivery events subscribed before real buyers.
7. **Switching SMS on later is configuration only** once templates 2.1 and 2.2 are approved:
   the keys in INDIA-DLT-TEMPLATES.md section 4, then one real-handset test per operator.
