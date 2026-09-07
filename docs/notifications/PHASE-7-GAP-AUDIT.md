# Phase 7 gap audit

The notification subsystem, end to end, before Phase 7 changed anything.

`CODE_GAP` — buildable here. `CONFIG_GAP` — a variable or contract, buildable here.
`EXTERNAL_SETUP` — somebody else's console. `OPTIONAL_FUTURE` — real, deliberately not built.

| Capability                                                            | Complete | Gap                                                                                            | External blocker        | Action                                                       |
| --------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------ |
| Domain events (`SHOW_CANCELLED` handler, outbox)                      | ✅       | —                                                                                              | —                       | none                                                         |
| Producers (booking, refund, settlement, show change/cancel, reminder) | ✅       | —                                                                                              | —                       | none                                                         |
| Policy resolver (channels, guarantees, consent, fallback)             | ✅       | —                                                                                              | —                       | none                                                         |
| Provider resolver (market → provider, refuses rather than guesses)    | ✅       | —                                                                                              | —                       | none                                                         |
| **Meta WhatsApp adapter**                                             | ❌       | **CODE_GAP** — sent `type: 'text'`, which WhatsApp refuses for business-initiated messages     | —                       | **Fixed**: sends an approved template                        |
| MSG91 SMS / WhatsApp adapters                                         | ✅       | —                                                                                              | DLT + template approval | none                                                         |
| Twilio adapter                                                        | ⚠️       | **CODE_GAP** — SDK errors thrown unclassified, so a dead number read as an outage              | —                       | **Fixed**: `classifyTwilioError`                             |
| **Provider error model**                                              | ❌       | **CODE_GAP** — every failure recorded `PROVIDER_UNAVAILABLE`                                   | —                       | **Fixed**: `FailureClass` + `CONFIGURATION_BLOCKED`          |
| **Retry policy**                                                      | ⚠️       | **CODE_GAP** — a missing credential burned 3 attempts and was blamed on the provider           | —                       | **Fixed**: retry derived from the class                      |
| **Missing credential handling**                                       | ❌       | **CODE_GAP** — threw a bare `Error`, unclassifiable                                            | —                       | **Fixed**: `CONFIGURATION_ERROR`                             |
| Notification worker (sweep, bounded, idempotent)                      | ✅       | —                                                                                              | —                       | none                                                         |
| Fallback / reminder / cancellation-fanout workers                     | ✅       | —                                                                                              | —                       | none                                                         |
| Preference + consent APIs (web and mobile)                            | ✅       | —                                                                                              | —                       | none                                                         |
| Suppression (bounce, complaint, STOP, lift)                           | ✅       | —                                                                                              | —                       | none                                                         |
| Delivery receipts + per-attempt history                               | ✅       | —                                                                                              | webhook registration    | none                                                         |
| Webhook handlers (Twilio, Meta, MSG91, SNS)                           | ✅       | —                                                                                              | —                       | none                                                         |
| Metrics + analytics + rate cards                                      | ✅       | —                                                                                              | contract rates          | none                                                         |
| **Market enablement**                                                 | ❌       | **CONFIG_GAP** — markets hardcoded `['IN','US','CA']`; unlaunched Canada reported as a blocker | —                       | **Fixed**: `NOTIFICATION_MARKETS`                            |
| **External template binding**                                         | ⚠️       | **CONFIG_GAP** — one id per type; no locale, no provider, no category                          | approvals               | **Fixed**: `NOTIFICATION_TEMPLATE_BINDINGS`                  |
| **DLT readiness**                                                     | ❌       | **CONFIG_GAP** — reported as generic `MISSING`                                                 | DLT registration        | **Fixed**: `BLOCKED_DLT` + PE/header keys                    |
| **Provider capability matrix**                                        | ❌       | **CODE_GAP** — the same facts copied into four places                                          | —                       | **Fixed**: `PROVIDER_CAPABILITIES`                           |
| **Template payload validation**                                       | ❌       | **CODE_GAP** — a blank `eventTitle` rendered a confident, useless sentence                     | —                       | **Fixed**: contracts, enforced on templated channels         |
| **SMS segment / DLT tooling**                                         | ❌       | **CODE_GAP** — no way to know a template's cost before submitting it                           | —                       | **Fixed**: `/readiness/templates/sms`                        |
| **WhatsApp template readiness**                                       | ❌       | **CODE_GAP**                                                                                   | approvals               | **Fixed**: `/readiness/templates/whatsapp`                   |
| **Link safety**                                                       | ❌       | **CODE_GAP** — push used `payload.url` verbatim                                                | —                       | **Fixed**: origin allowlist, HTTPS only                      |
| **Configuration diagnostics**                                         | ❌       | **CODE_GAP** — readiness could not separate config from templates from callbacks               | —                       | **Fixed**: `/readiness/configuration`                        |
| **Certification evidence**                                            | ⚠️       | **CODE_GAP** — derived only; nowhere to record who certified, or why a market is blocked       | —                       | **Fixed**: `NotificationCertification`                       |
| **Contract test harness**                                             | ❌       | **CODE_GAP** — no adapter was exercised against provider misbehaviour                          | —                       | **Fixed**: 30 tests, `CONTRACT_TESTED`                       |
| **Operator recovery filters**                                         | ⚠️       | **CODE_GAP** — `status=FAILED` was one undifferentiated list                                   | —                       | **Fixed**: `failureClass`, `configBlocked`, `retryExhausted` |
| **Deployment manifests**                                              | ❌       | **CONFIG_GAP** — 4–6 of 31 variables declared                                                  | —                       | **Fixed**: full section + 42 new gate checks                 |
| **India/US/CA flow proof**                                            | ❌       | **CODE_GAP** — every part tested, the combination not                                          | —                       | **Fixed**: 10 scenarios                                      |
| **Flaky fallback test**                                               | ❌       | **CODE_GAP** — assertions read global sweep state                                              | —                       | **Fixed**: scoped + advisory lock                            |
| SES configuration set                                                 | ⚠️       | **CONFIG_GAP** — absent from readiness                                                         | AWS console             | **Fixed**                                                    |
| Meta verify token                                                     | ⚠️       | **CONFIG_GAP** — absent from readiness                                                         | Meta console            | **Fixed**                                                    |
| Provider credentials, DLT, templates, rates                           | ❌       | **EXTERNAL_SETUP**                                                                             | all of it               | [EXTERNAL-SETUP-CHECKLIST](./EXTERNAL-SETUP-CHECKLIST.md)    |
| Bulk resend after an outage                                           | ❌       | **OPTIONAL_FUTURE**                                                                            | —                       | per-notification today; a real gap past a few hundred        |
| Admin notification console (UI)                                       | ❌       | **OPTIONAL_FUTURE**                                                                            | —                       | the admin API is complete; no screen                         |
| Quiet hours                                                           | ❌       | **OPTIONAL_FUTURE**                                                                            | —                       | deferred in ADR-049                                          |
| Same-channel provider failover                                        | ❌       | **OPTIONAL_FUTURE**                                                                            | —                       | explicitly out of scope                                      |
| Pull-based receipt reconciliation                                     | ❌       | **OPTIONAL_FUTURE**                                                                            | —                       | webhook outages lose events on providers with no pull API    |
| Locales beyond `en` / `fr-CA`                                         | ❌       | **OPTIONAL_FUTURE**                                                                            | —                       | deferred                                                     |

---

## What the audit changed about the plan

Three findings were not on the Phase 7 brief and were worth more than several items that were.

**The Meta WhatsApp adapter could never have worked.** It sent `type: 'text'`. WhatsApp
permits free-form text only inside a 24-hour window the recipient opens by writing first, and
every message this platform sends is business-initiated. The first real North American
WhatsApp message would have been refused, and the 400 would have read as a credential problem
rather than a message-shape one. The capability matrix had said `requiresTemplate: true` for
`cloud` all along; nothing was checking the adapter against it.

**Every failure was recorded as the provider being unreachable.** A missing MSG91 auth key, an
unapproved DLT template, a dead phone number and Twilio actually being down were four rows
that differed only in prose. The consequence was not cosmetic: provider health counted our own
unfinished setup against the provider, so an unopened India read as a 100% MSG91 outage — and
a real outage would have been invisible inside it.

**`SnsVerifier` broke application boot**, found in Phase 6 by the module-graph test after all
18 of its unit tests passed. Mentioned here because it is the same shape as the first two:
a component correct in isolation, wrong in composition, and silent about it.
