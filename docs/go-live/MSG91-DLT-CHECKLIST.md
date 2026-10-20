# MSG91 and DLT checklist (India SMS), with WhatsApp and Twilio gates

Owner requirements (2026-10-20):

- "Prepare the MSG91/DLT configuration checklist using ETKTGO as the candidate header, but require
  portal evidence of approval before enabling it."
- "Keep India SMS, WhatsApp and production notifications disabled until their respective readiness
  checks pass."

This is an operator checklist. Nothing here has been run. No key, id or secret appears on this page,
and none should be added. Exact template texts are owned by
`apps/api/src/notifications/templates/dlt-sms-templates.ts`; the owner copies are
[../notifications/INDIA-DLT-TEMPLATES.md](../notifications/INDIA-DLT-TEMPLATES.md) and
[../notifications/INDIA-DLT-SHOW-CANCELLED-REPLACEMENT.md](../notifications/INDIA-DLT-SHOW-CANCELLED-REPLACEMENT.md).
The email checklist is [PROD-SES-SNS-CHECKLIST.md](PROD-SES-SNS-CHECKLIST.md).

## Where things are today (read-only audit, 2026-10-20)

- No MSG91 auth key, sender header, PE id, template ids or webhook secret on PROD or QA.
- No DLT content template is approved (none submitted as of 2026-10-16).
- The repository records header **DPTRCS** as APPROVED (header ID 1705179188054799869) and
  **ETKTGO** as REJECTED (owner facts, 2026-10-14). The live site says DPTRCS.
- PE: DeepTrics Software Solutions Private Limited, PE ID 1701179092181018311.

## The code refuses ETKTGO today

Setting ETKTGO in configuration today **stops the PROD API from booting** whenever MSG91 carries SMS.
Three places hold the current decision:

| Where                                                              | What it does                                                                           |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| `apps/api/src/notifications/templates/dlt-sms-templates.ts`        | `REJECTED_SENDER_HEADERS = ['ETKTGO']`; `DOCUMENTED_APPROVED_SENDER_HEADER = 'DPTRCS'` |
| `apps/api/src/config/configuration.ts` (`dltConfigContradictions`) | boot is refused if `DLT_SENDER_HEADER` or `MSG91_SENDER_ID` is a rejected header       |
| `apps/customer-web/lib/legal-entity.ts`                            | `INDIA_SMS_SENDER_HEADER = 'DPTRCS'`, shown on About > Legal and business information  |

So ETKTGO can be used only in this order: **portal evidence (Gate 0), then a code PR, then
configuration.** Never the other way round.

---

## Gate 0. Portal evidence that ETKTGO is approved (before ANY configuration)

- [ ] A screenshot or export from the DLT portal (signed in as DeepTrics Software Solutions Private
      Limited) showing:
  - header **ETKTGO**, status **Approved**
  - under PE **1701179092181018311**
  - the header ID, type (Transactional / Service) and approval date
- [ ] The approval date is **after 2026-10-14** (the recorded rejection), or the owner explains in
      writing why the earlier record was wrong.
- [ ] The evidence is attached to the code PR in Gate 1 and stored with the launch evidence.

If Gate 0 cannot be met, stop here. Keep DPTRCS (already approved) and use the existing pages
INDIA-DLT-TEMPLATES.md and INDIA-DLT-SHOW-CANCELLED-REPLACEMENT.md unchanged.

## Gate 1. Code PR that accepts ETKTGO (after Gate 0, before configuration)

- [ ] `dlt-sms-templates.ts`: `DOCUMENTED_APPROVED_SENDER_HEADER = 'ETKTGO'`; remove ETKTGO from
      `REJECTED_SENDER_HEADERS` (decide whether DPTRCS stays allowed as a second approved header).
- [ ] `configuration.ts`: the example in the six-letter error message names the approved header.
- [ ] `sms.transport.ts`: the comment that says ETKTGO was rejected.
- [ ] `apps/customer-web/lib/legal-entity.ts`: `INDIA_SMS_SENDER_HEADER` (the site sender text).
- [ ] Docs: INDIA-DLT-TEMPLATES.md section 1 table, INDIA-DLT-SHOW-CANCELLED-REPLACEMENT.md section 2,
      OWNER-CONFIGURATION.md item 5, `deploy/railway/env/production.env.example` header comment.
- [ ] Tests that pin the header: `dlt-sms-templates.spec.ts` (doc checks for DPTRCS and
      "ETKTGO ... REJECTED"), `configuration.sms.spec.ts`, `msg91.transport.spec.ts`,
      `provider-contract.spec.ts`, `phone-otp.msg91-dlt.spec.ts`,
      `notification-readiness.india-dlt.spec.ts`, `apps/customer-web/lib/legal-entity.test.ts`,
      `apps/e2e/tests/public-compliance.spec.ts`.
- [ ] CI green, merged, and PROD runs a commit that contains it (pinned deploy) **before** any
      ETKTGO value is set on PROD.

## Gate 2. PE-TM chain

- [ ] On the DLT portal, MSG91 is linked to the PE as its telemarketer (PE-TM binding), and the
      chain shows Active.
- [ ] In MSG91, the PE ID is saved and header ETKTGO is added to the account.
- [ ] (If the operator's portal requires it) the full chain PE -> MSG91 -> MSG91's delivery TM is
      declared. Screenshot it.

## Gate 3. Content templates submitted and approved

Register each under header **ETKTGO** (the header the templates are linked to must be the header
that is sent). Template type **Transactional (service)**, content category **Service Implicit**,
English, plain ASCII. No URLs. Every `{#var#}` is at most 30 characters. For variable type, choose
the free-text / alphanumeric type for every variable. Copy each text exactly.

| #   | Kind                         | Required?              | Variables, in order                    |
| --- | ---------------------------- | ---------------------- | -------------------------------------- |
| 1   | Sign-in code (OTP)           | **yes**                | `otp`, `minutes`                       |
| 2   | Show cancelled (current)     | yes, unless 2A is used | `event`, `when`, `reference`           |
| 2A  | Show cancelled, paid online  | recommended            | `event`, `when`, `reference`           |
| 2B  | Show cancelled, paid in cash | recommended            | `event`, `when`, `reference`, `amount` |
| 3   | Booking confirmed            | optional               | `reference`, `event`, `when`           |
| 4   | Booking cancelled            | optional               | `reference`                            |
| 5   | Refund sent                  | optional               | `amount`, `reference`                  |

Exact DLT texts (from `dlt-sms-templates.ts`):

```text
1  {#var#} is your ETicketsGo sign-in code. It expires in {#var#} minutes. Never share it with anyone.
2  ETicketsGo: {#var#} on {#var#} is cancelled. Booking {#var#}. Check your email for refund details. - DeepTrics
2A ETicketsGo: {#var#} on {#var#} is cancelled. Booking {#var#}. Your refund will go to the account you paid from. - DeepTrics
2B ETicketsGo: {#var#} on {#var#} is cancelled. Booking {#var#}. You paid {#var#} in cash. Show this booking at the venue box office to get your cash back. - DeepTrics
3  ETicketsGo: Booking {#var#} for {#var#} on {#var#} is confirmed. Your tickets are in your email and in your account. - DeepTrics
4  ETicketsGo: Booking {#var#} is cancelled. Check your email for refund details. - DeepTrics
5  ETicketsGo: We have refunded {#var#} for booking {#var#}. Your bank may take a few working days to show it. - DeepTrics
```

(The number and space at the start of each line are labels here; they are not part of the text.)

Variable formats: `otp` 6 digits; `minutes` `10`; `event` up to 30 characters (longer titles are cut
to 27 + `...`); `when` like `01 Nov 2026, 07:00 PM` in the venue's time zone; `reference` like
`ETG-IN-2026-000042`; `amount` like `Rs 1250.50`.

- [ ] Templates 1 and 2 (or 2A) **Approved**; screenshot of each with its 19-digit Content Template ID.
- [ ] Optional templates recorded as approved, pending or not submitted.

## Gate 4. MSG91 templates and id mapping

- [ ] For each approved template: MSG91 > SMS > Templates > add. Paste the text with each `{#var#}`
      written as `##name##` using the variable names above, for example
      `##otp## is your ETicketsGo sign-in code. It expires in ##minutes## minutes. Never share it with anyone.`
      Enter the DLT template ID and choose sender ETKTGO. Write down MSG91's own template id.
- [ ] Mapping table filled in (kept outside the repository):

| Template | MSG91 id variable                          | DLT id variable (19 digits)             |
| -------- | ------------------------------------------ | --------------------------------------- |
| 1        | `MSG91_SMS_TEMPLATE_OTP`                   | `DLT_TEMPLATE_ID_OTP`                   |
| 2        | `MSG91_SMS_TEMPLATE_SHOW_CANCELLED`        | `DLT_TEMPLATE_ID_SHOW_CANCELLED`        |
| 2A       | `MSG91_SMS_TEMPLATE_SHOW_CANCELLED_ONLINE` | `DLT_TEMPLATE_ID_SHOW_CANCELLED_ONLINE` |
| 2B       | `MSG91_SMS_TEMPLATE_SHOW_CANCELLED_CASH`   | `DLT_TEMPLATE_ID_SHOW_CANCELLED_CASH`   |
| 3        | `MSG91_SMS_TEMPLATE_BOOKING_CONFIRMED`     | `DLT_TEMPLATE_ID_BOOKING_CONFIRMED`     |
| 4        | `MSG91_SMS_TEMPLATE_BOOKING_CANCELLED`     | `DLT_TEMPLATE_ID_BOOKING_CANCELLED`     |
| 5        | `MSG91_SMS_TEMPLATE_REFUND_COMPLETED`      | `DLT_TEMPLATE_ID_REFUND_COMPLETED`      |

- [ ] MSG91 delivery reports (DLR) webhook set to
      `https://api.eticketsgo.com/api/notifications/webhooks/msg91/<MSG91_WEBHOOK_SECRET>`.

## Gate 5. Configuration (names only; api AND worker)

Set with `C:\etg-wt\prod-deploy-kit\set-var.mjs` (skipDeploys), then a pinned deploy, exactly as in
`C:\etg-wt\PROD-PINNED-DEPLOY-PROCEDURE.md` and PROD-SES-SNS-CHECKLIST.md Gate 8. Keep
`SMS_ENABLED=false` during this gate.

| Variable                      | Holds                                                       |
| ----------------------------- | ----------------------------------------------------------- |
| `MSG91_AUTH_KEY`              | secret                                                      |
| `DLT_SENDER_HEADER`           | `ETKTGO` (only after Gate 1 is deployed)                    |
| `MSG91_SENDER_ID`             | `ETKTGO`; must equal `DLT_SENDER_HEADER` or boot is refused |
| `DLT_PRINCIPAL_ENTITY_ID`     | the 19-digit PE ID                                          |
| `MSG91_WEBHOOK_SECRET`        | secret, 32+ random characters, the one in the DLR URL       |
| the Gate 4 template variables | both ids for every approved template                        |

- Leave unset: `OTP_SMS_TEMPLATE`, `MSG91_SMS_TEMPLATE_ID`, `MSG91_SMS_BODY_VAR` (each refuses boot
  when MSG91 carries SMS and the value is wrong or removed).
- A DLT id that is set and is not 19 digits refuses boot. Set the MSG91 id in the same change as its
  DLT id.
- [ ] Every set-var ended with "no deployment started"; pinned deploys exited 0; the api booted.

## Gate 6. Readiness, then carrier tests, then routing

- [ ] With the keys set, route India to MSG91 **with SMS still off**: `SMS_PROVIDER_BY_MARKET=IN=msg91`,
      `NOTIFICATION_MARKETS` includes `IN`, `SMS_ENABLED=false`. Pinned deploy.
- [ ] `GET /api/admin/notifications/readiness/configuration` (market IN): SMS provider `msg91`, no
      `BLOCKED_DLT` gap, no missing key.
- [ ] `GET /api/admin/notifications/readiness/templates/sms`: templates 1 and 2 (or 2A) bound.
- [ ] An SMS rate row exists for MSG91 India (`GET /api/admin/notifications/analytics/rates`).
- [ ] **Carrier test on UAT first** (UAT runs the Gate 1 commit; same MSG91 account and templates;
      no public buyers): one real
      sign-in code to a team phone on **Jio**, one on **Airtel**, one on **Vi**. For each: the
      wording matches the template exactly, it arrives within one minute, from ETKTGO, and the MSG91
      DLR reaches the API (delivery state updated). If a show-cancelled template is approved, send
      one of each kind too.
- [ ] Then on PROD, in an agreed short window: `SMS_ENABLED=true` with
      `SMS_PROVIDER_BY_MARKET=IN=msg91` (add `,US=twilio,CA=twilio` only after the Twilio gate below).
      Repeat the three-carrier sign-in test on PROD.
- [ ] `/api/capabilities` now lists `IN` in `phoneSignInCountries`.
- [ ] Rollback for this gate: `SMS_ENABLED=false` with set-var, then
      `redeploy-same.mjs`. The phone tab disappears and email sign-in continues.

## India SMS readiness gate (all must pass before customers see phone sign-in)

1. Gate 0 evidence attached (ETKTGO Approved under PE 1701179092181018311).
2. Gate 1 code PR merged and deployed to PROD.
3. PE-TM chain Active.
4. Templates 1 and 2 (or 2A) Approved, each with its DLT id; added in MSG91 under ETKTGO.
5. All Gate 5 variables set on api and worker; boot clean; readiness shows no `BLOCKED_DLT`.
6. DLR webhook delivering (a delivery state changed by a real MSG91 DLR).
7. Jio, Airtel and Vi tests passed on UAT and on PROD.
8. SMS rate row present.
9. Owner sign-off recorded.

## WhatsApp readiness gate (stays `WHATSAPP_PROVIDER=log` until all pass)

1. **Known code defect fixed first.** No message producer fills `whatsappTemplateVars`, so both
   WhatsApp transports (`whatsapp.transport.ts`, Meta Cloud and MSG91) send the whole rendered body
   as ONE template variable. Meta does not approve a template that is only a variable, and the body
   contains line breaks and long text. A code PR must pass structured variables (reference, event,
   time, amount) per message type, matching the approved templates.
2. Templates approved with **structured variables** (`{{1}}`, `{{2}}` ...), category Utility, per
   message type and locale, and bound with `NOTIFICATION_TEMPLATE_BINDINGS` (or
   `MSG91_WHATSAPP_TEMPLATES` for MSG91).
3. Opt-in: WhatsApp opt-in is collected and recorded before `WHATSAPP_TRANSACTIONAL_OPT_IN_REQUIRED=true`
   is turned on (turning it on with no opt-ins stops all WhatsApp).
4. Provider set up: MSG91 WhatsApp BSP (`MSG91_WHATSAPP_NUMBER`) or Meta Cloud
   (`WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN` permanent system-user token,
   `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`; webhook
   `https://api.eticketsgo.com/api/notifications/webhooks/whatsapp/cloud`, field `messages`).
5. `GET /api/admin/notifications/readiness/templates/whatsapp` shows every needed type bound.
6. A rate row per WhatsApp category.
7. One real message per type to a team phone, with its status callback received.
8. The log-mode WhatsApp rows recorded as `SENT/log` (INDIA-COMMUNICATIONS.md E4) are understood
   and excluded from delivery counts.

## Twilio US and Canada readiness gate (stays off until all pass)

1. A **separate** Twilio account or subaccount for PROD; never QA's credentials.
2. PROD keys `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_MESSAGING_SERVICE_SID` on api and worker
   (absent today).
3. A2P 10DLC brand and campaign approved for US (docs/compliance/A2P_10DLC_READINESS.md), and a
   Canadian sender that is allowed to send (toll-free verification or another Canada-capable
   sender in the Messaging Service pool); geographic permissions US and CA only.
4. Messaging Service status callback
   `https://api.eticketsgo.com/api/notifications/webhooks/twilio`, and inbound (POST)
   `https://api.eticketsgo.com/api/notifications/webhooks/twilio/inbound`; Advanced Opt-Out on.
5. `PUBLIC_API_URL` equals `https://api.eticketsgo.com` byte for byte (Twilio signs the URL).
6. Twilio rate row; a real code to a US and a Canadian team number; status callback and STOP/START
   tested.
7. Only then add `US=twilio,CA=twilio` to `SMS_PROVIDER_BY_MARKET` and the markets to
   `NOTIFICATION_MARKETS`.

## What stays disabled until its gate passes

| Setting                                | Value until the gate passes                                                                | Gate                         |
| -------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------- |
| `SMS_ENABLED`                          | `false`                                                                                    | India SMS gate / Twilio gate |
| `SMS_PROVIDER`                         | `log`; `SMS_PROVIDER_BY_MARKET` unset or without the market                                | same                         |
| `WHATSAPP_PROVIDER`                    | `log`; `WHATSAPP_PROVIDER_BY_MARKET` unset                                                 | WhatsApp gate                |
| Phone sign-in tab                      | hidden: `/api/capabilities` gives `phoneSignInCountries: []` (follows `SMS_ENABLED=false`) | India SMS gate               |
| `DLT_SENDER_HEADER`, `MSG91_SENDER_ID` | unset (ETKTGO refused by the code today)                                                   | Gates 0 and 1                |
| Email                                  | `EMAIL_PROVIDER=log` until PROD-SES-SNS-CHECKLIST.md passes                                | SES gate                     |

## Evidence to attach (outside the repository)

- [ ] Gate 0 portal screenshot or export (ETKTGO Approved, PE 1701179092181018311, header ID, date)
- [ ] Gate 1 PR link and the PROD commit containing it
- [ ] PE-TM chain screenshot
- [ ] Each approved template with its Content Template ID; each MSG91 template page
- [ ] set-var and deploy-pinned outputs
- [ ] Readiness configuration and templates/sms output for IN
- [ ] Carrier test record: carrier, time sent, time received, sender shown, DLR state (no phone
      numbers, no codes)
- [ ] `/api/capabilities` before and after
