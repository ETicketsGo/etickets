# India pilot production readiness (2026-10-12)

Scope: a controlled India pilot with 3 to 5 real organizers and about 10 general-admission (GA) events,
INR, Razorpay, email-only customer communication. Regulated cinema ticketing stays off.

This page is the decision summary. The detail is in:

| Area                     | Document                                               |
| ------------------------ | ------------------------------------------------------ |
| Infrastructure           | [INFRASTRUCTURE.md](INFRASTRUCTURE.md)                 |
| Razorpay                 | [RAZORPAY-READINESS.md](RAZORPAY-READINESS.md)         |
| Communications           | [INDIA-COMMUNICATIONS.md](INDIA-COMMUNICATIONS.md)     |
| Operations and staffing  | [OPERATING-PROCEDURES.md](OPERATING-PROCEDURES.md)     |
| End-to-end journey       | [PILOT-JOURNEY.md](PILOT-JOURNEY.md)                   |
| QA and UAT certification | [CERTIFICATION-EVIDENCE.md](CERTIFICATION-EVIDENCE.md) |

## Recommendation: NO-GO today, GO when the owner actions below are done

The product journey works on QA, which runs current main. Every step from organizer sign-up to a held
payout was proven with Razorpay test money, including failure and recovery cases (70 pass, 1 fail,
6 blocked). The pilot is not blocked by missing features. It is blocked by:

1. **Production runs code 322 to 377 commits behind main.** None of this month's payout, authorization
   and pricing safeguards are live there. Production also has no admin user and no current backup.
2. **The live Razorpay webhook secret does not match.** A real paid purchase was rejected on
   2026-10-06, and that money (Rs 519.18) is still not refunded.
3. **Nobody can do maker-checker yet.** Bank verification and "mark paid" need two independent finance
   people. Production has no admin at all.
4. **One finance display defect (FIN-1).** After refunds, the organizer's held and pending totals still
   show the refunded amount. The payout itself is correct.

None of these can be closed by engineering alone. Each needs an owner decision, an account action or
an approved production change.

## 1. Readiness matrix

Status: **READY** = proven on QA at current main. **OWNER** = code ready, waiting on an owner action.
**BLOCKED** = cannot be proven or used until something external happens. **GAP** = a product gap with a
written workaround.

| Gate           | Item                                                  | Status  | Evidence or next step                                                                  |
| -------------- | ----------------------------------------------------- | ------- | -------------------------------------------------------------------------------------- |
| Journey        | Organizer sign-up, organization, legal identity, bank | READY   | CERTIFICATION-EVIDENCE, journey ONB                                                    |
| Journey        | GA event creation, admin approval, publishing         | READY   | journey EVT                                                                            |
| Journey        | Customer purchase with Razorpay (test)                | READY   | journey PAY on QA; UAT confirms late (shared test webhook)                             |
| Journey        | Ticket delivery (notification record, QR)             | READY   | Real mailbox receipt not proven (BLOCKED on SES production access)                     |
| Journey        | QR check-in, duplicate and tampered scans refused     | READY   | journey CHK                                                                            |
| Journey        | Invited gate staff can scan                           | READY   | Fixed in #338 (was refused: G2); verify on QA after deploy                             |
| Journey        | Customer refund, organizer cancellation refunds       | READY   | Two Razorpay test refunds COMPLETED                                                    |
| Journey        | Reconciliation                                        | BLOCKED | Discrepancy queue empty, but no proof it compared with Razorpay (REC-3)                |
| Journey        | Payout generation after the hold                      | READY   | Net 99,800 = 299,600 gross minus 199,800 refunds                                       |
| Journey        | Payout marked paid only after independent bank check  | OWNER   | 409 hold proven; a second finance person is needed to complete it                      |
| Finance        | Organizer held and pending totals after refunds       | GAP     | FIN-1: frozen read model, fix needs owner approval; mitigation in section 4            |
| Payments       | Live account KYC, capture mode, methods               | OWNER   | RAZORPAY-READINESS S1 to S3                                                            |
| Payments       | Live webhook secret matches                           | OWNER   | S4 (rotation by the owner)                                                             |
| Payments       | Stranded live payment refunded                        | OWNER   | S7                                                                                     |
| Payments       | Complete payment certification (A to D)               | OWNER   | S6, S8, S9, S11 on production after the deploy                                         |
| Payments       | Instant payment stop                                  | GAP     | Only the whole-site maintenance flag exists (G19)                                      |
| Payments       | Provider transfers (Route)                            | OFF     | Kept off by the owner release gate; pilot uses the platform payout path                |
| Communications | Email (receipts, tickets, refunds)                    | OWNER   | SES production access, DKIM/SPF/DMARC, SNS subscription                                |
| Communications | SMS, OTP sign-in, WhatsApp                            | BLOCKED | DLT registration; pilot runs email-only with `SMS_ENABLED=false` (#337)                |
| Infrastructure | Production on current main                            | OWNER   | Approved deploy with a backup first                                                    |
| Infrastructure | Managed secrets, production identity                  | OWNER   | INFRASTRUCTURE 1.4                                                                     |
| Infrastructure | Nightly backup running and fresh                      | OWNER   | Backup freshness now reported by `/api/admin/ops/health` (#336); PROD db-seed redeploy |
| Infrastructure | Restore verified in isolation                         | READY   | `scripts/ops/restore-drill.sh`, local RTO 75 s; production-size RTO not measured       |
| Infrastructure | Alerting with a named roster                          | OWNER   | Rules in `observability/prometheus/pilot-alerts.yml`; roster blank (G18)               |
| Infrastructure | Environment isolation                                 | OWNER   | Rotate the PROD database password, then run the isolation comparison                   |
| Operations     | First production admin                                | OWNER   | Production has 0 super admins and 0 grants                                             |
| Operations     | Two finance people plus a reviewer                    | OWNER   | OPERATING-PROCEDURES section 7                                                         |
| Operations     | Verifier is not the payer                             | GAP     | One capability covers both (G1); procedural rule until changed                         |
| Operations     | Event-level cancel with refunds                       | GAP     | Cancel each show instead (G3); dialog wording is wrong (G15)                           |
| Operations     | Failed refund retry                                   | GAP     | Manual payment from the Razorpay dashboard (G14)                                       |
| Scope          | Regulated cinema pricing                              | OFF     | Stays off; Vijayawada partial, Hyderabad not selling (fail-closed)                     |
| Certification  | UAT                                                   | BLOCKED | UAT runs a build about 260 commits behind; its failures are old behaviour              |

## 2. Owner actions, in order

Each line is something only the owner (or someone the owner names) can do. Nothing here was done by
engineering.

**Before the production deploy**

1. Name the people: Finance A, Finance B (independent of A), a reviewer/support person, and the page
   roster. Fill `ESCALATION-MATRIX.md` section 1.
2. Create the production IAM principal and the live payment secrets; set the five variables
   (INFRASTRUCTURE 1.4).
3. Redeploy PROD `db-seed` once, read the next 02:05 UTC log, and turn on Railway volume backups
   (INFRASTRUCTURE 2.4). Decide whether to fund an off-platform dump copy.
4. Rotate the PROD Postgres password; run the isolation comparison (INFRASTRUCTURE 5).
5. Confirm production dashboard auto-deploy is off.
6. In AWS: confirm SES production access and domain verification (DKIM, SPF, DMARC), and subscribe and
   confirm the SNS topic.

**The production deploy (needs explicit approval)**

7. Take a verified backup, then deploy current main to PROD: api, worker, then the three web apps
   (INFRASTRUCTURE 4.1).
8. Set `SMS_ENABLED=false` on api and worker and `EMAIL_PROVIDER=ses`. Remove
   `ALLOW_UNDELIVERABLE_NOTIFICATIONS` after one real email is received.
9. Create the first production admin and grant the staff presets: Finance A = FINANCE, Finance B =
   FINANCE, reviewer = MODERATOR + SUPPORT. Never grant PLATFORM_CONFIG, PAYMENT_ADMIN or ADMIN_MANAGE
   to pilot staff.

**Razorpay (RAZORPAY-READINESS section 2)**

10. S1 to S3: confirm KYC and activation, set capture to automatic, confirm payment methods.
11. S4: rotate the webhook secret on Razorpay and in production together; S5: the signature alert.
12. S7: refund `pay_TkVxCS4BmDljlf` (Rs 519.18) from the Razorpay dashboard.
13. S6, S8, S9: one smallest real purchase, a partial and a full refund, and a settlement match.
14. S11 and S13: run the payment certification; open sales only when it is fully green, and record
    who decided and when.

**Decisions**

15. FIN-1: approve the read-model fix (CERTIFICATION-EVIDENCE, finding 2), or accept the mitigation.
16. G1: accept "verifier is not the payer" as a written rule for the pilot, or approve splitting the
    capability.
17. G19: accept the whole-site maintenance flag as the payment stop for the pilot, or approve a
    payment-only switch.
18. UAT: approve a UAT redeploy (it runs migrations) before UAT is used as evidence again.

## 3. Infrastructure and payment blockers

| Blocker                                                                | Class          | Unblocked by                  |
| ---------------------------------------------------------------------- | -------------- | ----------------------------- |
| Production 322 to 377 commits behind main                              | Infrastructure | Actions 7, 8                  |
| Production cannot boot current main without the secret store principal | Infrastructure | Action 2                      |
| No current production backup                                           | Infrastructure | Action 3                      |
| No admin in production                                                 | Operations     | Action 9                      |
| No paged roster, no running alert rules                                | Infrastructure | Actions 1, 5                  |
| Live webhook secret mismatch                                           | Payment        | Action 11                     |
| Stranded live payment Rs 519.18                                        | Payment        | Action 12                     |
| Capture mode not set in code; `payment.authorized` is ignored          | Payment        | Action 10 (automatic capture) |
| Payment certification not run on production                            | Payment        | Actions 13, 14                |
| Email not proven to a real mailbox                                     | Communications | Action 6                      |

## 4. Pilot operating procedures

The full procedures are in [OPERATING-PROCEDURES.md](OPERATING-PROCEDURES.md). The rules that matter
most for a first pilot:

- **GA only, INR only, one country.** The reviewer refuses cinema events, seated events, non-INR
  prices and organizations outside India (there is no launch-market switch, G6).
- **Approve organizations before their events.** A pending organization can submit events (G5), so
  the reviewer checks the organization status first.
- **Maker-checker on money.** The person who verifies a bank account never marks a payout to it paid.
  Both names go in the payout evidence.
- **Read the payout row, not the totals (FIN-1).** Until the fix is approved, organizers and finance
  staff read gross, refunds and net on the payout row. The "held" and "pending" totals overstate what
  is owed after refunds.
- **Cancelling an event:** cancel each show. Refunds open automatically, even though the dialog says
  they do not (G15). Tell the organizer before they cancel.
- **Failed refund:** pay the customer from the Razorpay dashboard and record the reference (G14).
- **Check-in online only.** Offline check-in is off (G4). A network error shows as "Not valid" (G11),
  so staff retry before turning anyone away.
- **Daily:** check the support inbox (nothing notifies, G17), failed or bounced emails (G22), backup
  freshness on `/api/admin/ops/health`, and the run of `scripts/ops/pilot-health-check.mjs`.

## 5. Rollback plan

From [INFRASTRUCTURE.md 4.3](INFRASTRUCTURE.md) and [INCIDENT-RESPONSE.md](INCIDENT-RESPONSE.md).
Code rolls back. The database does not: migrations are forward-only.

| Situation                                          | Action                                                                                                                                             |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Config or flag problem                             | Fix the variable or the `FEATURE_*` flag. Do not roll back code.                                                                                   |
| Web regression                                     | Redeploy the previous web deployment.                                                                                                              |
| API or worker regression, additive migrations only | Redeploy the previous worker, then api, then web.                                                                                                  |
| Regression after a constraint migration            | Fix forward. Old images can fail on the new schema (two October migrations are one-way).                                                           |
| Payment incident                                   | Turn on maintenance to stop new purchases; reconcile against the Razorpay dashboard.                                                               |
| Data corruption                                    | Stop api and worker; restore the newest verified dump to a scratch database, compare, then restore in a window. Reconcile payments since the dump. |

The first production deploy is safe to roll forward only: production holds no live events, so the
October one-way migrations apply to an empty catalogue. Take the backup before it anyway.

**Stop the pilot sales** (proposed triggers; the owner ratifies them, G20) when any of these happens: a paid
purchase is not confirmed within 15 minutes, a refund is recorded but not sent, a webhook signature
failure, a payout that disagrees with its settlement, or a backup older than 26 hours.

## 6. Launch dependencies and estimates

The estimates are for planning only. External lead times are not in our control.

| Dependency                                       | Who                 | Estimate (working days)        |
| ------------------------------------------------ | ------------------- | ------------------------------ |
| Name staff and the page roster                   | Owner               | 1                              |
| Production IAM principal, secrets, variables     | Owner + engineering | 1 to 2                         |
| Backups running and verified on PROD             | Owner + engineering | 2 (needs one nightly run)      |
| Production deploy of main, first admin, grants   | Owner + engineering | 1                              |
| Razorpay S1 to S5, S7                            | Owner (+ Razorpay)  | 1 to 5 (Razorpay support time) |
| SES production access, DNS, SNS                  | Owner (+ AWS)       | 1 to 3 (AWS review time)       |
| Payment certification on production (S6 to S13)  | Owner + engineering | 2 to 3 (settlement takes T+2)  |
| FIN-1 fix, if approved                           | Engineering         | 1 to 2                         |
| Onboard the first organizer and event            | Owner + reviewer    | 1 to 2                         |
| DLT and SMS (not needed for an email-only pilot) | Owner (+ operators) | 10 to 30                       |

Critical path without SMS: about **7 to 12 working days** from the day the owner starts, most of it
waiting on Razorpay, AWS and the first settlement.

## 7. GO criteria

Change this to GO when all of these are true and recorded:

1. Production runs current main, with a verified backup taken before the deploy.
2. The payment certification (RAZORPAY-READINESS section 3) is fully green on production.
3. Two independent finance people and a reviewer hold their grants, and the roster is filled.
4. One real email reached a real mailbox from production.
5. FIN-1 is fixed, or the owner has accepted the mitigation in writing.
6. The stranded Rs 519.18 payment is refunded.
