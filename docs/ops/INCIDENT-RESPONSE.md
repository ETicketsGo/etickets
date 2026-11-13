# Security incident and personal-data breach response

**Who runs it:** the owner is incident lead, communications lead and the person who files reports (founder-operated).

**Applies to:** any suspected unauthorised access to, or loss or disclosure of, personal data, credentials, or payment information, whether it happens in our systems or at a provider.

## The clocks (start when we become aware)

| Who                               | What                                                                                                      | Deadline                                                                                                          | Basis                                                                                                                                                                                            |
| --------------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **CERT-In** (India)               | Report qualifying cyber incidents, including data breaches, unauthorised access and compromise of systems | **6 hours**                                                                                                       | CERT-In Directions under IT Act s.70B(6), 28 Apr 2022 ([PDF](https://www.cert-in.org.in/PDF/CERT-In_Directions_70B_28.04.2022.pdf)); report via incident@cert-in.org.in using the published form |
| **Data Protection Board** (India) | Intimation without delay, then a detailed report                                                          | **72 hours** (detailed)                                                                                           | DPDP Rules, Rule 7. **From 13 May 2027.**                                                                                                                                                        |
| **Affected Indian users**         | Plain-language notice: what happened, likely impact, what we are doing, what they can do, contact         | Without delay                                                                                                     | DPDP Rule 7 (from 13 May 2027)                                                                                                                                                                   |
| **Affected US residents**         | Notice per their state's law                                                                              | Most states: "without unreasonable delay", some 30–60 days. Some states also require AG notice above a threshold. | 50 state laws (for example Cal. Civ. Code 1798.82)                                                                                                                                               |
| **Razorpay / Stripe**             | Any suspected compromise touching payment flows, keys or webhooks                                         | Immediately                                                                                                       | Merchant agreements; PCI DSS                                                                                                                                                                     |
| **Canada** (once live)            | OPC report plus individual notice, where there is a real risk of significant harm                         | As soon as feasible                                                                                               | PIPEDA s.10.1                                                                                                                                                                                    |

**Counsel on call:** «name / firm / phone». Call counsel within the first hour of a confirmed breach. Counsel decides whether a report is legally required; **CERT-In's 6 hours does not wait for that decision.** If in doubt, file and update.

## First hour

1. **Contain.** Pick whichever applies:
   - Rotate the exposed credential (Railway variable).
   - Revoke the provider key (Razorpay or Stripe dashboard).
   - Suspend the account (admin console).
   - Take a public route down (remove its domain).
   - Roll back a deploy (`rollback.mjs`).
2. **Preserve evidence. Do not delete anything.**
   - Take a database dump (`predeploy-backup.sh`) and a read-only fingerprint (`prod-fp.sql`).
   - Save the Railway logs for the window. Railway's retention is short; copy them to the case folder now.
   - Collect the provider dashboards (Razorpay, Stripe, AWS SES, MSG91, Twilio) and Cloudflare/GoDaddy DNS history.
3. **Start the incident record** in `docs/security/INCIDENT-<date>-<slug>.md`, following the format of `INCIDENT-2026-11-06-NEXT-IMAGE-OPTIMIZER.md`. Record a timeline in UTC and IST: aware-at, contained-at, and each notification sent.

## Assess (hours 1–4)

- **Scope.** Which data classes are involved? Use the inventory in the audit (identity/contact, consent, tax ids, bank details (encrypted), payment references, webhook payloads).
- **Scale.** How many people, in which countries? Use `Booking.currency` / `Venue.country` / `User.countryOfResidence` aggregates via the read-only role. Never export rows to count them.
- **Containment.** Is it contained? Could it recur?

## Notify

Send the notices in the table above, using counsel's text. Keep copies in the incident record.

## Close

- Root cause, fix PR, and a regression test.
- Memory or runbook update.
- Post-incident review within 7 days.

## Readiness checklist (do now, not during an incident)

- [ ] Counsel named above.
- [ ] CERT-In reporting form downloaded; incident@cert-in.org.in saved.
- [ ] Log retention decision recorded (remediation doc, external question 1).
- [ ] Alerts reach the owner's phone. Production alerting was staged on 2026-11-09; confirm it is live.
- [ ] One table-top exercise per year: walk a "leaked DATABASE_URL" scenario through this page.
