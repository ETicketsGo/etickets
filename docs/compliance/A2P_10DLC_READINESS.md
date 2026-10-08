# A2P 10DLC readiness — ETicketsGo

Everything needed to complete Twilio's A2P 10DLC brand and campaign application without
re-deriving it from the codebase. No secrets appear in this document.

**Status: the website requirements are LIVE AND VERIFIED IN PRODUCTION** (main `94a969d`,
walkthrough 2026-10-06, 59 checks against `https://www.eticketsgo.com`). Twilio approval,
production Twilio credentials, the brand's tax/address records, and legal review are external
and still outstanding — see [External dependencies](#external-dependencies).

A copy-paste section for the Twilio form is at the end: [Twilio submission content](#twilio-submission-content).

---

## Brand

| Field                     | Value                                   | Where it comes from                                         |
| ------------------------- | --------------------------------------- | ----------------------------------------------------------- |
| Customer-facing brand     | **ETicketsGo**                          | `BUSINESS_DETAILS`                                          |
| US legal entity           | **DeepTrics LLC**                       | `LEGAL_ENTITIES.US` in `packages/shared-types/src/legal.ts` |
| India legal entity        | **Deeptrics Software Solution Pvt Ltd** | `LEGAL_ENTITIES.IN`                                         |
| Brand line shown publicly | ETicketsGo, operated by DeepTrics LLC   | `PLATFORM_OPERATOR`                                         |
| Website                   | `https://www.eticketsgo.com`            | production domain                                           |
| Support email             | `support@eticketsgo.com`                | `BUSINESS_DETAILS.supportEmail`                             |

EIN / tax ID, registered address and support phone are **not** in the repository. They are
required by the brand registration form and must come from the business.

## Campaign

| Field               | Value                                                                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Use case            | **Mixed**                                                                                                                                              |
| Messages            | account verification (OTP), booking confirmations, ticket delivery and entry details, event changes and cancellations, refund updates, support replies |
| Promotional content | Only to recipients who separately opted in. Never inherited from a purchase.                                                                           |
| Opt-in URL          | `https://www.eticketsgo.com/sms`                                                                                                                       |
| Terms URL           | `https://www.eticketsgo.com/terms`                                                                                                                     |
| Privacy URL         | `https://www.eticketsgo.com/privacy`                                                                                                                   |
| SMS programme URL   | `https://www.eticketsgo.com/sms`                                                                                                                       |
| Cookie policy       | `https://www.eticketsgo.com/cookies`                                                                                                                   |
| Refund policy       | `https://www.eticketsgo.com/refunds`                                                                                                                   |

All reachable without authentication, HTTP 200, indexable, mobile-rendered.

## Opt-in mechanism

**Transactional messages** are sent because of a booking or a sign-in the person initiated.
They are not marketing and do not consult the marketing consent record — see
`apps/api/src/notifications/message-class.ts`.

**Promotional messages require a separate, explicit opt-in**, captured when a signed-in person
turns on text messages in their notification settings
(`/account/notification-settings`). The control is **off by default**, is separate from
accepting Terms, and is separate from the email marketing control.

There is deliberately **no public form that accepts a phone number**. An unverified number
typed into a public box is weaker evidence than a signed-in account toggle, and it would let
anyone enter somebody else's number. The number recorded against a consent is read
server-side from the account's **verified** number; an account with no verified number records
no number rather than an unverified one.

### Disclosure shown at the point of consent

Published at `/sms`, and summarised in Terms section 9 and Privacy section 7:

- who sends the messages (ETicketsGo, with the operating entity named)
- what is sent, as a list of the real message types
- "Message frequency depends on what you do." — deliberately not a fixed number, because the
  product does not enforce one
- "**Message and data rates may apply.**"
- "Reply **STOP** … or **HELP** for help." START resumes.
- "**Agreeing to text messages is not a condition of buying a ticket.**"
- "We do not sell your mobile number, and we do not share it with third parties or affiliates
  for their own marketing."
- links to Terms and Privacy

## STOP / HELP

Handled by **Twilio Advanced Opt-Out**, which replies to the sender in their own language.
Our inbound webhook records the resulting state so application preferences and provider state
cannot drift apart.

| Keyword | Behaviour                                                                                               |
| ------- | ------------------------------------------------------------------------------------------------------- |
| STOP    | Twilio replies and blocks. Our webhook records the suppression, so later sends are refused locally too. |
| START   | Lifts the suppression on both sides.                                                                    |
| HELP    | Twilio replies with the configured help text, which must name ETicketsGo and `support@eticketsgo.com`.  |

Endpoints (signed, HMAC-SHA1, verified against `PUBLIC_API_URL` byte-for-byte):

- Status callback — `POST https://api.eticketsgo.com/api/notifications/webhooks/twilio`
- Inbound keywords — `POST https://api.eticketsgo.com/api/notifications/webhooks/twilio/inbound`

The inbound endpoint answers **empty TwiML** on purpose: Twilio has already replied, and a
second `<Message>` would text the person twice.

## Sample messages

Drawn from real notification types. Final wording is registered as provider templates with
Twilio; the content below is what those templates carry.

| Type                      | Sample                                                                                                                              |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| OTP                       | `ETicketsGo: your sign-in code is 123456. It expires in 10 minutes. Do not share it.`                                               |
| Booking confirmed         | `ETicketsGo: your tickets for Comedy Night are confirmed. Booking ETG-IN-2026-00123. View: https://www.eticketsgo.com/booking/find` |
| Event changed             | `ETicketsGo: the time for Comedy Night has changed to 7:30 pm on 19 Oct. Your ticket is still valid.`                               |
| Event cancelled           | `ETicketsGo: Comedy Night on 19 Oct has been cancelled. A refund has been started. Reply HELP for help.`                            |
| Refund completed          | `ETicketsGo: your refund of 519.18 INR for booking ETG-IN-2026-00123 has been sent.`                                                |
| Promotional (opt-in only) | `ETicketsGo: tickets for Comedy Night in Hyderabad go on sale Friday. Reply STOP to stop these.`                                    |

Every sample names ETicketsGo. The promotional sample carries an opt-out reminder; the
transactional ones do not, because they are not promotional.

## Consent evidence stored

`MarketingConsent` is **append-only** — a withdrawal is a new row, never an edit — so the
history can be reconstructed and produced on request.

| Column                   | Meaning                                                                                                                                        |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `userId`, `email`        | the subject. Email keyed as well as account, so a guest who withdrew is not resubscribed by registering.                                       |
| `channel`                | `sms`, `whatsapp`, `email`, `push`                                                                                                             |
| `granted`                | the decision                                                                                                                                   |
| `source`                 | how it was obtained, e.g. `account-settings:sms`, `withdrawn-by-user:sms`. Set server-side, never accepted from the client.                    |
| `country`                | the market the decision was made in                                                                                                            |
| `policyVersion`          | the exact disclosure shown, e.g. `SMS/US/v1`. The client may name a country; the **version is resolved server-side** from the policy registry. |
| `phone`                  | the verified number the consent is for. Messaging channels only.                                                                               |
| `ipAddress`, `userAgent` | provenance, when the request carried them                                                                                                      |
| `createdAt`              | when                                                                                                                                           |

Readable by the person themselves (`GET /me/marketing-consent` returns state _and_ history, so
a data-subject request is already an endpoint) and by administrators. **Never public.**

### What is never treated as consent

Creating an account, accepting Terms, buying a ticket, providing a phone number, and verifying
an OTP all grant nothing. `mayReceiveMarketing` returns `latest?.granted ?? false`, and the
only writer of a consent row is the authenticated account-settings endpoint.

## Country-aware policies

`getApplicablePolicy(type, country)` in `packages/shared-types/src/legal.ts` resolves a policy
from the registry, preferring a country supplement and falling back to `GLOBAL`. Every type has
a current `GLOBAL` row, which a test enforces, so no market can render an empty legal page.

Country comes from the URL (`?country=US|IN|CA|GLOBAL`) and is **never inferred from IP**.
Every version is one visible click away on every legal page.

## Verification procedure

1. `https://www.eticketsgo.com/sms` returns 200 unauthenticated and shows every disclosure.
2. The footer links Terms, Privacy, Refund policy, Text messages and Cookies on desktop and
   mobile, from the home page.
3. `/terms?country=IN` names Deeptrics Software Solution Pvt Ltd and `TERMS/IN/v1`;
   `?country=US` names DeepTrics LLC and `TERMS/US/v1`.
4. In notification settings, text messages start **off**; turning them on writes a
   `MarketingConsent` row with country, policy version and the verified number.
5. A Twilio dashboard test or any real delivery returns 2xx and does not increment
   `payment_webhooks{result="signature_invalid"}` — that counter is for payments; for messaging
   watch the delivery webhook logs.
6. STOP suppresses; a later promotional send is refused; START resumes.

### Screenshot targets for the application

- `/sms` at 390px and 1440px — the full disclosure
- `/account/notification-settings` — the unchecked control, before and after
- `/terms?country=US` — operator, version and effective date
- the footer showing the legal links

## External dependencies

Outside the repository. None is an engineering defect.

| Dependency                                              | State                                                                                                                                    |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Twilio A2P brand + campaign approval                    | **not submitted**                                                                                                                        |
| Twilio production credentials                           | **absent** — PROD api and worker carry `SMS_PROVIDER` but no `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` or `TWILIO_MESSAGING_SERVICE_SID` |
| Messaging Service + sender, Advanced Opt-Out, callbacks | not configured — see `docs/notifications/EXTERNAL-SETUP-CHECKLIST.md`                                                                    |
| Provider message templates                              | not registered                                                                                                                           |
| EIN / registered address / support phone                | not published                                                                                                                            |
| Legal review of the documents                           | not done                                                                                                                                 |
| India DLT registration                                  | separate and still outstanding                                                                                                           |

Until credentials exist, `SMS_PROVIDER` resolves to the `log` transport: messages are recorded
and never sent. That is a safe default, not a silent failure — nothing is delivered and nothing
pretends to be.

---

# Twilio submission content

Copy-paste values for the A2P 10DLC forms. Every value below is determined from the
repository or verified on production. Fields that must come from corporate records or the
Twilio Console are marked **[FROM BUSINESS]** and are deliberately left blank.

## Brand registration

| Field                                               | Value                        |
| --------------------------------------------------- | ---------------------------- |
| Legal company name                                  | `DeepTrics LLC`              |
| Brand / DBA                                         | `ETicketsGo`                 |
| Entity type                                         | `Private Profit`             |
| Country                                             | `United States`              |
| Website                                             | `https://www.eticketsgo.com` |
| Support email                                       | `support@eticketsgo.com`     |
| Vertical                                            | `ENTERTAINMENT`              |
| EIN / Tax ID                                        | **[FROM BUSINESS]**          |
| Registered street address, city, state, postal code | **[FROM BUSINESS]**          |
| Support phone (E.164)                               | **[FROM BUSINESS]**          |

India operates through a separate entity, `Deeptrics Software Solution Pvt Ltd`. It is **not**
part of this US registration and is named here only so the two are not confused.

## Campaign

**Use case:** `Mixed`

**Campaign description** (paste as-is):

> ETicketsGo is an online ticketing platform for films and live events. We send text messages
> to people who have an account or a booking with us: one-time sign-in codes, booking
> confirmations with ticket details, entry information and reminders for events they booked,
> notices when an event is rescheduled or cancelled, refund updates, and replies to support
> requests. Customers who separately opt in may also receive messages about other events.
> Promotional consent is never taken from a purchase, an account, a phone number, an OTP or
> acceptance of our terms.

**How customers opt in** (paste as-is):

> Transactional messages relate to a booking or sign-in the customer started themselves.
> Promotional messages require a separate opt-in: a signed-in customer opens Account >
> Notification settings and turns on text messages. The control is off by default, is separate
> from accepting our Terms, and is separate from the email marketing control. Each decision is
> stored as an append-only record with the account, the verified mobile number, the market, the
> exact disclosure version shown, the source screen and the timestamp. The programme, including
> the full disclosure, is published at https://www.eticketsgo.com/sms

**Opt-in URL:** `https://www.eticketsgo.com/sms`

**Consent disclosure** (the text shown with the opt-in; paste as-is):

> ETicketsGo sends text messages about your account and the tickets you bought. Message
> frequency depends on what you do. Message and data rates may apply. Reply STOP to any message
> to stop receiving them, or HELP for help. Agreeing to text messages is not a condition of
> buying a ticket. See our Terms at https://www.eticketsgo.com/terms and our Privacy Policy at
> https://www.eticketsgo.com/privacy

| Field             | Value                                       |
| ----------------- | ------------------------------------------- |
| Terms URL         | `https://www.eticketsgo.com/terms`          |
| Privacy URL       | `https://www.eticketsgo.com/privacy`        |
| SMS programme URL | `https://www.eticketsgo.com/sms`            |
| Message frequency | `Message frequency depends on what you do.` |
| Rates disclosure  | `Message and data rates may apply.`         |
| Help / support    | `support@eticketsgo.com`                    |

**Opt-out (STOP) response** — Twilio Advanced Opt-Out replies; our webhook records the
suppression so application state cannot drift from the carrier's:

> You are unsubscribed from ETicketsGo messages. No more messages will be sent. Reply START to
> resume. Reply HELP for help.

**HELP response:**

> ETicketsGo ticket and account messages. Help: support@eticketsgo.com. Reply STOP to
> unsubscribe. Message and data rates may apply.

## Sample messages

Each maps to a real notification type in the platform.

1. `ETicketsGo: your sign-in code is 123456. It expires in 10 minutes. Do not share it.`
2. `ETicketsGo: your tickets for Comedy Night are confirmed. Booking ETG-US-2026-00123. View your tickets: https://www.eticketsgo.com/booking/find`
3. `ETicketsGo: the start time for Comedy Night has changed to 7:30 PM on Oct 19. Your ticket is still valid.`
4. `ETicketsGo: Comedy Night on Oct 19 has been cancelled. A refund has been started. Reply HELP for help.`
5. `ETicketsGo: your refund of $24.99 for booking ETG-US-2026-00123 has been sent.`
6. `ETicketsGo: tickets for Comedy Night in Austin go on sale Friday at 10 AM. Reply STOP to stop these.`

Sample 6 is the only promotional one and goes only to customers who opted in; it carries the
opt-out reminder. The transactional samples do not, because they are not promotional.

## Twilio Console configuration (not in this repository)

| Setting                                  | Required value                                                                                                              |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Messaging Service status callback        | `https://api.eticketsgo.com/api/notifications/webhooks/twilio`                                                              |
| Messaging Service inbound webhook (POST) | `https://api.eticketsgo.com/api/notifications/webhooks/twilio/inbound`                                                      |
| Advanced Opt-Out                         | **Enabled** — without it Twilio blocks STOPped numbers but never reports `OptOutType`, so local opt-out state cannot follow |
| Geographic permissions                   | US and Canada                                                                                                               |
| `PUBLIC_API_URL` on the API service      | must equal `https://api.eticketsgo.com` byte-for-byte; Twilio signs the URL                                                 |
