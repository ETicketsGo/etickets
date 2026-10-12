# India pilot readiness (revised 2026-10-12, round K)

Scope: a controlled India pilot with 3 to 5 organizers and at least 10 general-admission (GA) events, INR,
Razorpay, email-only customer communication. Regulated cinema ticketing stays off.

This page replaces the first version of the same date. It was checked against the repository at main, the QA
deployment and a read-only production assessment on 2026-10-12. Three statements in the first version were wrong
and are corrected here (marked "corrected").

| Area                             | Document                                                                                   |
| -------------------------------- | ------------------------------------------------------------------------------------------ |
| Infrastructure                   | [INFRASTRUCTURE.md](INFRASTRUCTURE.md)                                                     |
| Razorpay                         | [RAZORPAY-READINESS.md](RAZORPAY-READINESS.md)                                             |
| Communications                   | [INDIA-COMMUNICATIONS.md](INDIA-COMMUNICATIONS.md)                                         |
| Real-email certification         | [REAL-EMAIL-CERTIFICATION.md](REAL-EMAIL-CERTIFICATION.md)                                 |
| Operating playbook               | [PILOT-PLAYBOOK.md](PILOT-PLAYBOOK.md), [OPERATING-PROCEDURES.md](OPERATING-PROCEDURES.md) |
| Finance separation of duties     | FINANCE-SEPARATION-OF-DUTIES.md (in PR #343, awaiting approval)                            |
| FIN-1 root cause                 | docs/finance/FIN-1-ROOT-CAUSE.md (in PR #341, awaiting approval)                           |
| Customer journey review          | [CUSTOMER-JOURNEY-REVIEW.md](CUSTOMER-JOURNEY-REVIEW.md)                                   |
| Cross-browser certification      | [CROSS-BROWSER-CERTIFICATION.md](CROSS-BROWSER-CERTIFICATION.md)                           |
| QA and UAT journey certification | [CERTIFICATION-EVIDENCE.md](CERTIFICATION-EVIDENCE.md)                                     |

## Decision: NO-GO

The decision belongs to the owner and is unchanged. The product works on QA. The pilot is blocked by production
state, finance approvals, staffing and provider checks, not by missing features.

**Urgent, found in this round:** production is publicly serving and selling today. www.eticketsgo.com lists two
published demo events ("Hyderabad Live: Comedy Night" on 2026-10-19 and "Hyderabad Live: Music Festival" on
2026-11-02, organizer "ETicketsGo Presents") with paid INR tickets on live Razorpay, on code 348 to 403 commits
behind main. Nobody can use the payment stop there, because it needs an admin and production has none. Owner
decision: unpublish both events (or set maintenance) until the pilot is approved.

## 1. GO/NO-GO matrix

PASS = proven with evidence. FAIL = proven wrong or missing. BLOCKED = cannot be proven without an external
dependency or an approval. A test whose dependency is unavailable is never PASS.

| Workstream                     | Status    | Evidence                                                                                                  | Owner action                                  | Effort           |
| ------------------------------ | --------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ---------------- |
| 1 Cross-browser UI             | PASS (QA) | 308 cells pass in Chromium, Firefox, WebKit; 2 real defects fixed (#345); real Safari/iOS/Android BLOCKED | Test on one real iPhone and one Android phone | 0.5 day          |
| 2 Customer experience          | PASS (QA) | Money agrees from event page to receipt; 4 defects fixed (#344); email receipt BLOCKED                    | Confirm a support email to print at checkout  | 0.5 day          |
| 3 FIN-1 finance totals         | FAIL      | Root cause found and fixed in #341; read models only; awaiting approval                                   | Approve #341                                  | 0.5 day after OK |
| 4 Production readiness         | FAIL      | Read-only assessment below                                                                                | Sections 4 and 10                             | 3 to 5 days      |
| 5 Razorpay                     | BLOCKED   | 4 live payments need dashboard checks; webhook secret likely fixed, unproven                              | Section 5                                     | 1 to 5 days      |
| 6 Finance separation of duties | FAIL      | Enforced in code in #343 (awaiting approval); no staff named or granted                                   | Approve #343; name the people                 | 1 day            |
| 7 Pilot operations             | BLOCKED   | Playbook merged (#342); roster, agreement and legal sign-off empty                                        | Fill roster, agreement, sign-offs             | 3 to 10 days     |
| 8 Release controls             | PASS      | Every change went through PR, CI on exact head, QA deploy; finance PRs held for approval                  | None                                          | -                |

## 2. Cross-browser findings

Full matrix and screenshots: [CROSS-BROWSER-CERTIFICATION.md](CROSS-BROWSER-CERTIFICATION.md), screenshots in
`C:\etg-wt\k-shots\k-browser\`. The owner's own screenshots did not reach engineering, so these are the real
differences found, not a confirmed match with what the owner saw.

- **Fixed (#345):** when signed in, the header overflowed at 1024 to 1279 px in every engine (up to 253 px of
  sideways scroll, account menu off screen). The links now show as icons until there is room.
- **Fixed (#345):** WebKit showed a false "A new version of ETicketsGo is available" banner on a first visit (4 of
  6 fresh profiles), covering the bottom navigation.
- **Environment, not defects:** city/location state changes what discovery shows; QA data changed between runs;
  the customer site is light-only by design; native selects differ by browser.
- **Not answerable today:** no build id or commit is exposed by the pages, so "which build is this browser on"
  cannot be read from the page. Caching is correct: HTML is not cached, hashed assets are immutable, and the
  service worker caches only the offline page.
- **BLOCKED:** real Safari, iOS and Android devices. Playwright WebKit on Windows is not Safari.

## 3. FIN-1 root cause and proposed fix

Full trace: docs/finance/FIN-1-ROOT-CAUSE.md in PR #341.

- **Symptom:** after refunds, the organizer Payouts page showed Rs 2,996 held and the Finance page Rs 2,996
  pending, while the payout row correctly showed Rs 998 net.
- **Cause 1:** `PayoutsService.heldRevenue` summed booking subtotals and never deducted refunds.
- **Cause 2:** the Finance read model counted a Razorpay settlement at its full sales value before any money moved,
  and added it on top of the platform payout for the same event. The settlement exists because one is created for
  every paid event, even when the organizer has no Razorpay linked account.
- **Can it move money:** no. Payout generation, marking paid and settlement release read their own data and refuse
  overlaps. A new test proves the two read pages change no rows.
- **Fix (read models only):** held deducts completed refunds with the payout's own arithmetic; an unmoved
  settlement counts sales minus refunds; a settlement whose event a platform payout already covers stays listed
  with its double-claim warning but is not added to the totals.
- **Tests:** a real-Postgres test rebuilds the QA case; it failed on the old code and passes now; each part of the
  fix is load-bearing; full API suite green (6,190 tests).
- **Residual risk:** the settlement and the platform payout use different fee bases (107,791 against 99,800 on the
  QA data); disputes are not deducted before release. Rollback: revert the PR; no data change.
- **Until approved:** organizers and finance staff read gross, refunds and net on the payout row only.

## 4. Production readiness (read-only assessment, 2026-10-12)

Method: Railway deployment metadata and logs through the project token (no variables read), and read-only SQL in
`BEGIN READ ONLY` with `default_transaction_read_only=on`. Nothing was changed.

| Item                | Finding                                                                                                                                               | Status  |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| Deployed code       | api and customer-web d57f62c (348 behind main), worker 94a969d (358), organizer/admin c82f3cf (367), db-seed 311ebb7 (403); deployed 2026-10-04 to 07 | FAIL    |
| Public exposure     | www, api, admin and organizer .eticketsgo.com all serve; `/api/health` 200                                                                            | Note    |
| Migrations          | 112 applied, last `20261006210000_consent_evidence`; main has 119; 2 of the 7 pending are one-way                                                     | Note    |
| Backups (corrected) | Nightly dump written and read back (`pg_restore --list`) every day 2026-10-06 to 12, 02:01 UTC; 11 kept                                               | PASS    |
| Restore test        | No production dump has been restored into an isolated database                                                                                        | BLOCKED |
| Off-platform copy   | None; dumps live only in Railway                                                                                                                      | FAIL    |
| Admin bootstrap     | 3 users, 0 back-office roles, 0 admin grants                                                                                                          | FAIL    |
| Secrets identity    | Not checkable without reading production variables (not permitted); current main refuses to boot in production without the secret store principal     | BLOCKED |
| Email               | 0 notifications of any kind in the last 30 days; production email never proven                                                                        | BLOCKED |
| Monitoring          | Pilot alert rules exist in the repository but nothing runs them; roster empty                                                                         | FAIL    |
| Rollback            | Code rollback works for additive migrations; 2 pending migrations are one-way, so after the deploy roll forward                                       | Note    |

### Deployment runbook (for the approved deploy only)

1. Owner: unpublish or pause the two demo events; confirm dashboard auto-deploy is off.
2. Owner: create the production secrets principal and set its variables (INFRASTRUCTURE 1.4) with deploys
   skipped.
3. Take a fresh backup and restore it into a scratch database; record row counts (INFRASTRUCTURE 3).
4. Deploy main in this order: api (runs the 7 migrations), worker, customer-web, organizer-web, admin-web,
   db-seed. Wait for each to be healthy.
5. Run `node scripts/deploy/verify-deployed.mjs` with a token that cannot read variables, or the behaviour probes
   only; check `/api/health`, `/api/capabilities` and `/api/admin/ops/health` (backup field).
6. Bootstrap the first admin; grant the presets named in section 6.
7. Set `SMS_ENABLED=false`, `EMAIL_PROVIDER=ses`; remove `ALLOW_UNDELIVERABLE_NOTIFICATIONS` after one real email.
8. Run the payment certification (RAZORPAY-READINESS section 3) before publishing any pilot event.

### Rollback

| Situation                      | Action                                                                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Deploy fails before migrations | Redeploy the previous deployment ids; nothing else changed                                                                     |
| Regression after migrations    | Fix forward. Old images may fail on the one-way migrations (production has 0 seat maps, so the risk is small)                  |
| Payment problem                | Suspend payments for India with the payment outage API (PAYMENT_ADMIN); refunds and webhooks keep working                      |
| Site-wide problem              | Maintenance mode. It also blocks check-in, tickets and provider webhooks, so it is a last resort                               |
| Data corruption                | Stop api and worker; restore the newest verified dump into scratch, compare, then restore; reconcile payments against Razorpay |

## 5. Razorpay owner checklist

Detail: [RAZORPAY-READINESS.md](RAZORPAY-READINESS.md) section 2. Never paste keys or secrets into chat or
documents.

1. Dashboard, LIVE mode: confirm KYC complete, account activated, settlement bank verified.
2. Set payment capture to automatic. The code never sets capture mode and ignores `payment.authorized`.
3. Check four live payments by date and amount; production still has them as PROCESSING with expired bookings and
   no refund: Rs 830.28 on 2026-09-29 (21:54 UTC), Rs 830.28 twice on 2026-09-30 (07:07 and 08:12 UTC), Rs 519.18 on 2026-10-06
   (`pay_TkVxCS4BmDljlf`). Refund any that were captured, from the dashboard.
4. Webhooks (corrected): production stored a signed `secret.sync.verification` event on 2026-10-06 08:57 UTC, and
   it verifies the signature before storing, so the secret most likely matches since then. Confirm the webhook
   URL is `https://api.eticketsgo.com/api/payments/webhooks/razorpay` and that
   recent deliveries succeed. Rotate only as part of the approved deploy.
5. Methods: confirm UPI, domestic cards and netbanking; decide on international cards.
6. After the deploy: one smallest real purchase, a partial and a full refund from the app, and a settlement match
   (S6, S8, S9). Open sales only when the certification is fully green; record who decided.
7. Route/linked accounts stay off (owner release gate); pilot payouts use the platform path.

## 6. Finance staffing and permissions

Enforced in PR #343 (awaiting approval). Nothing is granted to anyone.

| Person                           | Preset           | Can                                                                              | Cannot                                             |
| -------------------------------- | ---------------- | -------------------------------------------------------------------------------- | -------------------------------------------------- |
| Finance A                        | FINANCE_VERIFIER | Read finance, reveal an account number (audited), verify or reject bank accounts | Mark paid, fail, approve or release                |
| Finance B                        | FINANCE_PAYER    | Mark payouts paid or failed, approve and release settlements                     | Verify bank accounts; pay an account they verified |
| Reviewer                         | FINANCE_REVIEWER | Read finance and the audit log                                                   | See bank accounts, move money                      |
| On-call operations               | OPS_ONCALL       | Ops health, retry queues, outbox and inventory sync                              | Money, bank data                                   |
| Payment stop holder (owner pick) | PAYMENT_ADMIN    | Suspend payments by country, provider or route                                   | Should not also be Finance A or B                  |

- The rule "the verifier never pays" is checked on identity in the same transaction as the bank-verification
  hold, so it also applies to a super admin and to anyone holding both duties. A refusal is a 403 with an audit
  row.
- After #343, the existing FINANCE preset no longer verifies or pays. Today nobody is affected (QA has only the
  super admin; production has no admins).
- Residual risk: two people colluding, or one person with two accounts. Use named people and review the audit log
  weekly.

## 7. Real-email certification requirements

Detail: [REAL-EMAIL-CERTIFICATION.md](REAL-EMAIL-CERTIFICATION.md).

- Owner: SES production access in the production AWS account; domain identity with DKIM, SPF (MAIL FROM) and
  DMARC records at the DNS host; configuration set, SNS topic and event destination; the production IAM user; the
  mailboxes (Gmail, Outlook, Yahoo, an Indian provider, a company domain).
- Decision needed: how to confirm the SNS subscription in production. Production never records the confirmation
  token, so a one-time reveal, a short capture window or an out-of-band confirmation must be chosen.
- PASS means: booking confirmation, refund and cancellation, password reset and guest link received in every
  mailbox, in the inbox, with SPF/DKIM/DMARC pass in the headers, links pointing at production hosts, and a bounce
  and a complaint recorded through SNS.
- Known product facts: the booking email carries no QR code (guests get a link; signed-in buyers sign in);
  organizer team invites are links the owner sends, not emails.

## 8. Pilot operating playbook

Detail: [PILOT-PLAYBOOK.md](PILOT-PLAYBOOK.md). The short version:

- GA, INR, India only. Regulated cinema stays off wherever pricing rules are unverified (Vijayawada partial,
  Hyderabad not selling).
- Approve the organization before its events; record the signed organizer agreement (the current one is a draft
  with blanks and the product records no acceptance).
- Gate staff are invited by the organizer owner (works since #338). Plan lanes from expected attendance; give each
  scanner its own mobile data.
- An organizer cannot cancel a whole GA event from a screen today; support handles it with the documented manual
  procedure.
- Failed refunds are paid manually from the Razorpay dashboard and recorded.
- Stop payments with the outage API, not maintenance mode.
- Daily report M1 to M20 from named endpoints and queries; weekly audit-log review of finance actions.

## 9. Critical-path timeline (working days, from the day the owner starts)

| Day     | Dependency                                                                       | Who                   |
| ------- | -------------------------------------------------------------------------------- | --------------------- |
| 0       | Pause the two live demo events                                                   | Owner                 |
| 0 to 1  | Approve #341 and #343; name Finance A, B, reviewer, on-call, payment-stop holder | Owner                 |
| 1       | Merge, deploy to QA, re-certify finance figures and the duty split on QA         | Engineering           |
| 1 to 3  | Secrets principal, AWS SES production access, DNS records                        | Owner (+ AWS)         |
| 1 to 5  | Razorpay checks 1 to 5 in section 5                                              | Owner (+ Razorpay)    |
| 2 to 3  | Restore drill on a production dump in scratch                                    | Owner approval + eng. |
| 3 to 5  | Approved production deploy, admin bootstrap, grants                              | Owner + engineering   |
| 4 to 6  | Real-email certification                                                         | Owner + engineering   |
| 5 to 8  | Live payment certification (purchase, refunds, settlement T+2)                   | Owner + engineering   |
| 3 to 10 | Organizer agreement, legal sign-offs, roster, first organizer onboarding         | Owner                 |

Realistic earliest GO: about 8 to 12 working days, set by Razorpay, AWS and the first settlement.

## 10. Next actions, ordered by dependency

**Owner (business):**

1. Pause the two production demo events.
2. Approve or reject #341 (FIN-1) and #343 (separation of duties).
3. Name Finance A, Finance B, the reviewer, on-call and the payment-stop holder; fill the escalation roster.
4. Finish the organizer agreement and the legal sign-off list (PILOT-PLAYBOOK section 8).
5. Decide the production SNS confirmation route.
6. Approve a restore drill of a production dump in an isolated scratch database.
7. Approve the production deploy window.

**Owner (providers):**

8. Razorpay checks 1 to 5 in section 5.
9. AWS: SES production access, domain identity, DNS records, SNS topic, production IAM user.
10. Production secrets principal and variables (INFRASTRUCTURE 1.4).

**Engineering (can start as soon as the matching owner step is done):**

11. After 2: merge, deploy to QA, re-read the pilot organizer's figures, prove the duty split with two QA staff
    accounts the owner creates.
12. After 6: run the restore drill and record RTO.
13. After 7 and 10: the production deploy runbook in section 4.
14. After 9: real-email certification.
15. After 8 and 13: the live payment certification; then the owner decides GO.

**Engineering, not blocked (proposals, small):** seller name and support contact at checkout; sticky pay button on
mobile; event-level sold-out notice; no Rs 0 tax invoice for free bookings; a build id in the page for support;
organizer screen to cancel a GA event with refunds.
