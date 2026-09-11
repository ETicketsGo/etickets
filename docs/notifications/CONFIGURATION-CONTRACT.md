# Configuration contract

Every variable the notification platform reads, what happens without it, and where it stands.

**No value appears on this page.** Names and states only.

## How the columns were established

- **Local** — parsed from `apps/api/.env`. **None of the notification variables appear in
  it.** Matches in `.env.example` / `.env.production.example` are documentation, not
  configuration.
- **QA / Production** — `NOT VERIFIED`, and not verifiable from here. The certification
  endpoint that answers this question honestly is on this branch, which is **not pushed and
  not deployed**; the QA deployment predates it. Reading Railway variables directly would mean
  handling secrets to answer a question an endpoint answers without them.

`DECLARED` means the key appears in `deploy/railway/env/<env>.env.example`, commented or
otherwise, so a deployment is at least shown that it exists. The deploy gate now asserts that:
removing one of these keys from a template fails `npm run verify:deploy`.

Fill the remaining columns by deploying this branch and running, per environment:

```
GET /api/admin/notifications/readiness/configuration   # per market/channel/provider, no values
GET /api/admin/notifications/readiness/certification
GET /api/admin/notifications/readiness/templates/sms
GET /api/admin/notifications/readiness/templates/whatsapp
```

---

## Email — Amazon SES

| Variable                | Required market | Secret  | Validation                                                                                             | Local   | QA           | Prod         |
| ----------------------- | --------------- | ------- | ------------------------------------------------------------------------------------------------------ | ------- | ------------ | ------------ |
| `EMAIL_PROVIDER`        | all             | no      | enum `log\|sendgrid\|ses`, default `log`; **boot fails** on `log` when `APP_ENV` is STAGING/PRODUCTION | MISSING | NOT VERIFIED | NOT VERIFIED |
| `EMAIL_FROM`            | all             | no      | **boot fails** if absent with a real provider                                                          | MISSING | NOT VERIFIED | NOT VERIFIED |
| `AWS_REGION`            | all             | no      | optional; SDK default chain                                                                            | MISSING | NOT VERIFIED | NOT VERIFIED |
| `AWS_ACCESS_KEY_ID`     | all             | **yes** | optional — omit where an IAM role supplies it                                                          | MISSING | NOT VERIFIED | NOT VERIFIED |
| `AWS_SECRET_ACCESS_KEY` | all             | **yes** | as above                                                                                               | MISSING | NOT VERIFIED | NOT VERIFIED |
| `SES_CONFIGURATION_SET` | all             | no      | optional in schema, **required in practice**                                                           | MISSING | NOT VERIFIED | NOT VERIFIED |
| `SES_WEBHOOK_SECRET`    | all             | **yes** | optional; the callback path 404s without it                                                            | MISSING | NOT VERIFIED | NOT VERIFIED |
| `PUBLIC_API_URL`        | all             | no      | optional; **cannot be inferred** behind a load balancer                                                | MISSING | NOT VERIFIED | NOT VERIFIED |

`EMAIL_PROVIDER=log` is the one place the schema itself refuses to start: a customer charged
for a ticket they never receive is worse than a service that will not boot. The escape hatch
is `ALLOW_UNDELIVERABLE_NOTIFICATIONS=true`, spelled out in full so nobody sets it by accident.

**`SES_CONFIGURATION_SET` is the trap.** Nullable, no error, no warning — and without it SES
publishes no events, so nothing is ever marked delivered and no bounce ever suppresses
anything. It stays optional because a deployment that genuinely wants no events should not
have to invent a name; it is documented as required everywhere it matters.

---

## SMS

| Variable                       | Required market  | Secret  | Validation                                                  | Local   | QA           | Prod         |
| ------------------------------ | ---------------- | ------- | ----------------------------------------------------------- | ------- | ------------ | ------------ |
| `SMS_PROVIDER`                 | fallback for all | no      | enum `log\|twilio\|msg91`, default `log`                    | MISSING | NOT VERIFIED | NOT VERIFIED |
| `SMS_PROVIDER_BY_MARKET`       | IN, US, CA       | no      | `IN=msg91,US=twilio,CA=twilio`; unparseable entries ignored | MISSING | NOT VERIFIED | NOT VERIFIED |
| `MSG91_AUTH_KEY`               | **IN**           | **yes** | none at boot; the transport refuses at send                 | MISSING | NOT VERIFIED | NOT VERIFIED |
| `MSG91_SENDER_ID`              | **IN**           | no      | must be the **DLT-registered header**                       | MISSING | NOT VERIFIED | NOT VERIFIED |
| `MSG91_SMS_TEMPLATE_IDS`       | **IN**           | no      | `TYPE=id,…`; a missing type is a **permanent** refusal      | MISSING | NOT VERIFIED | NOT VERIFIED |
| `MSG91_WEBHOOK_SECRET`         | **IN**           | **yes** | optional                                                    | MISSING | NOT VERIFIED | NOT VERIFIED |
| `TWILIO_ACCOUNT_SID`           | **US, CA**       | no      | none at boot                                                | MISSING | NOT VERIFIED | NOT VERIFIED |
| `TWILIO_AUTH_TOKEN`            | **US, CA**       | **yes** | also the HMAC key for callbacks                             | MISSING | NOT VERIFIED | NOT VERIFIED |
| `TWILIO_MESSAGING_SERVICE_SID` | **US, CA**       | no      | `MG` + 32 hex at boot; the only sender setting              | MISSING | NOT VERIFIED | NOT VERIFIED |
| `PUBLIC_API_URL`               | **US, CA**       | no      | origin only (no path) at boot; api only                     | MISSING | SET          | NOT VERIFIED |

Only `SHOW_CANCELLED` uses SMS, and only as a fallback — so **one** approved DLT template
launches India. With no template for a type, the transport fails that send permanently and
names the key to set: it does not guess, and it does not burn retries.

---

## WhatsApp

| Variable                      | Required market | Secret  | Validation                                | Local   | QA           | Prod         |
| ----------------------------- | --------------- | ------- | ----------------------------------------- | ------- | ------------ | ------------ |
| `WHATSAPP_PROVIDER`           | fallback        | no      | enum `log\|cloud\|msg91`, default `log`   | MISSING | NOT VERIFIED | NOT VERIFIED |
| `WHATSAPP_PROVIDER_BY_MARKET` | IN, US, CA      | no      | `IN=msg91,US=cloud,CA=cloud`              | MISSING | NOT VERIFIED | NOT VERIFIED |
| `MSG91_WHATSAPP_NUMBER`       | **IN**          | no      | E.164 without `+`                         | MISSING | NOT VERIFIED | NOT VERIFIED |
| `MSG91_WHATSAPP_TEMPLATES`    | **IN**          | no      | `TYPE=name,…` — **five types** need one   | MISSING | NOT VERIFIED | NOT VERIFIED |
| `MSG91_WHATSAPP_LANGUAGE`     | IN              | no      | defaults to `en`                          | MISSING | NOT VERIFIED | NOT VERIFIED |
| `WHATSAPP_PHONE_NUMBER_ID`    | **US, CA**      | no      | none at boot                              | MISSING | NOT VERIFIED | NOT VERIFIED |
| `WHATSAPP_ACCESS_TOKEN`       | **US, CA**      | **yes** | use a **permanent** system-user token     | MISSING | NOT VERIFIED | NOT VERIFIED |
| `WHATSAPP_APP_SECRET`         | **US, CA**      | **yes** | HMAC key for `X-Hub-Signature-256`        | MISSING | NOT VERIFIED | NOT VERIFIED |
| `WHATSAPP_VERIFY_TOKEN`       | **US, CA**      | **yes** | must match the Meta dashboard **exactly** | MISSING | NOT VERIFIED | NOT VERIFIED |

`WHATSAPP_VERIFY_TOKEN` gates whether a subscription can be created at all. Unset, Meta's
activation 401s and never sends anything — the POST handler is correct and idle.

---

## Push

| Variable           | Required market | Secret  | Validation                           | Local   | QA           | Prod         |
| ------------------ | --------------- | ------- | ------------------------------------ | ------- | ------------ | ------------ |
| `PUSH_PROVIDER`    | all             | no      | enum `log\|fcm\|expo`, default `log` | MISSING | NOT VERIFIED | NOT VERIFIED |
| `FCM_PROJECT_ID`   | only if `fcm`   | no      | —                                    | MISSING | NOT VERIFIED | NOT VERIFIED |
| `FCM_CLIENT_EMAIL` | only if `fcm`   | no      | —                                    | MISSING | NOT VERIFIED | NOT VERIFIED |
| `FCM_PRIVATE_KEY`  | only if `fcm`   | **yes** | —                                    | MISSING | NOT VERIFIED | NOT VERIFIED |

**`PUSH_PROVIDER=fcm` with the current mobile app reaches nobody.** The app registers
`ExponentPushToken[...]`, which FCM cannot deliver to, and nothing errors — sends are accepted
and land nowhere. `expo` matches what the app registers and needs no credential. This is
config-shaped and would not be caught by any validation, which is why it is stated here and in
the setup guide.

Push has no delivery callback on any provider. `ACCEPTED` is terminal, and certification
treats it as such rather than waiting forever for a receipt that does not exist.

---

## Markets, templates and DLT (Phase 7)

| Variable                         | Required market | Secret | Validation                                                                   | Local   | QA           | Prod         |
| -------------------------------- | --------------- | ------ | ---------------------------------------------------------------------------- | ------- | ------------ | ------------ |
| `NOTIFICATION_MARKETS`           | all             | no     | **boot fails** if a routing table names a market this does not enable        | MISSING | DECLARED     | DECLARED     |
| `NOTIFICATION_TEMPLATE_BINDINGS` | IN, US, CA      | no     | malformed entries dropped; **boot fails** on a provider no channel routes to | MISSING | DECLARED     | DECLARED     |
| `WHATSAPP_TEMPLATE_LANGUAGE`     | US, CA          | no     | fallback for a `*`-locale binding; defaults `en`                             | MISSING | NOT VERIFIED | NOT VERIFIED |
| `DLT_PRINCIPAL_ENTITY_ID`        | **IN**          | no     | recorded, never verified against a telecom system                            | MISSING | DECLARED     | DECLARED     |
| `DLT_SENDER_HEADER`              | **IN**          | no     | **boot fails** if it disagrees with `MSG91_SENDER_ID`                        | MISSING | DECLARED     | DECLARED     |

`NOTIFICATION_TEMPLATE_BINDINGS` supersedes `MSG91_SMS_TEMPLATE_IDS` and
`MSG91_WHATSAPP_TEMPLATES`. Both still work, read at lower priority as **wildcard-locale**
bindings — which is what they always meant, one id used for every language. The readiness
report counts them under `legacyTemplateBindings` so they can be migrated deliberately rather
than discovered when a French message goes out under an English approval.

**Nothing here refuses to boot for being incomplete.** A market half-way through its provider
setup is the normal state of a launch and is exactly what the readiness endpoint exists to
report; refusing to start would mean an operator cannot run the report that would tell them
what is missing. Boot refuses only **contradictions** — two settings that cannot both be what
somebody meant — plus the inherited `EMAIL_PROVIDER=log` guard, which exists because that
configuration charges customers and sends them nothing.

---

## Behaviour flags

| Variable                                 | Default    | Effect                                                                |
| ---------------------------------------- | ---------- | --------------------------------------------------------------------- |
| `NOTIFICATION_REMINDERS_ENABLED`         | `false`    | 24h show reminders. **Off at launch.**                                |
| `NOTIFICATION_REMINDER_LEAD_HOURS`       | `24`       | how far ahead                                                         |
| `WHATSAPP_TRANSACTIONAL_OPT_IN_REQUIRED` | `false`    | when true, WhatsApp is dropped for anyone who has not opted in        |
| `ALLOW_UNDELIVERABLE_NOTIFICATIONS`      | unset      | escape hatch past the email boot guard. **Never to serve customers.** |
| `NOTIFICATION_MARKETS`                   | `IN,US,CA` | which markets readiness reports on, and demands configuration for     |
| `NOTIFICATION_SWEEP_INTERVAL_MS`         | `5000`     | dispatch cadence (worker)                                             |
| `NOTIFICATION_FALLBACK_INTERVAL_MS`      | `60000`    | fallback sweep                                                        |
| `NOTIFICATION_FANOUT_INTERVAL_MS`        | `60000`    | cancellation fan-out safety net                                       |
| `NOTIFICATION_REMINDER_INTERVAL_MS`      | `300000`   | reminder sweep                                                        |

There is deliberately **no** `NOTIFICATIONS_ENABLED` master switch. Readiness is already per
market and per channel; one global flag would hide which part is actually ready, which is the
thing this whole phase exists to make visible.

---

## Minimum to launch a market

**India** — `EMAIL_PROVIDER=ses`, `EMAIL_FROM`, `AWS_REGION`, `SES_CONFIGURATION_SET`,
`SES_WEBHOOK_SECRET`, `PUBLIC_API_URL`, `SMS_PROVIDER_BY_MARKET`, `MSG91_AUTH_KEY`,
`MSG91_SENDER_ID`, `MSG91_SMS_TEMPLATE_IDS`, `MSG91_WEBHOOK_SECRET`,
`WHATSAPP_PROVIDER_BY_MARKET`, `MSG91_WHATSAPP_NUMBER`, `PUSH_PROVIDER=expo`,
`NOTIFICATION_MARKETS=IN`, `NOTIFICATION_TEMPLATE_BINDINGS`, `DLT_PRINCIPAL_ENTITY_ID`,
`DLT_SENDER_HEADER`.

**US / Canada** — the same email block, plus `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`,
`TWILIO_MESSAGING_SERVICE_SID`, `PUBLIC_API_URL`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN`,
`WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, `PUSH_PROVIDER=expo`, and
`NOTIFICATION_MARKETS` / `NOTIFICATION_TEMPLATE_BINDINGS` extended to cover them.

Plus, in both cases, a **rate per provider/channel/market** — otherwise every send costs
`UNKNOWN` and certification holds at `EXTERNAL_VERIFICATION_REQUIRED`. A channel that can send
and cannot be costed makes every total a silent floor.

Setting all of these produces `CONFIG_READY`. It does **not** produce a working channel: DLT
registration, template approval, SES production access, 10DLC and Meta subscription all happen
in somebody else's console. See [PROVIDER-SETUP.md](./PROVIDER-SETUP.md).
