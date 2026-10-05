# INDIA LAUNCH READINESS

Assessed at `main = c77a9cd`, 2026-10-05, while production deployment was blocked waiting for a
verified database backup. Read-only against production: nothing was deployed, activated or
charged.

The purpose was to make tomorrow short — so that once deployment unblocks, every remaining step
is a configuration change or a business decision rather than another investigation.

---

## Matrix

| Area                       | Code                                                                                        | Config                                                | External                                                | Human Decision                              | Ready?                                                |
| -------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------- |
| **Razorpay**               | Complete, traced end to end                                                                 | Live keys set on PROD; checkout path binds            | Live account active; one real order created + read back | —                                           | **Yes, on the checkout path**                         |
| **Webhook**                | Complete; 21 tests; signature, dedup, idempotency, ordering                                 | Endpoint live, secret set, refuses invalid signatures | Dashboard registration done by hand                     | Which events to subscribe (table corrected) | **Unproven** — only a paid purchase closes the secret |
| **Email**                  | Complete                                                                                    | SES configured on PROD                                | AWS SES                                                 | —                                           | **Probably** — never sent in production               |
| **SMS/OTP**                | Complete: hashed codes, 10-min TTL, 5 guesses, 5 sends/hour, fail-closed on send failure    | `SMS_PROVIDER` defaults to `log`; **no credentials**  | MSG91 account needed                                    | —                                           | **No**                                                |
| **DLT**                    | Fail-closed: a missing template is a visible permanent failure naming the key               | Every key exists and is unset                         | **DLT registration — long lead**                        | Bearer link by SMS?                         | **No**                                                |
| **GST**                    | Engine complete; shipped rate table now tested (13 tests) + order totals measured (6 tests) | Rules ship **inactive**; production charges `tax 0`   | —                                                       | **12 questions, 2 of them about money**     | **No — and it changes prices**                        |
| **Business details**       | One guarded source; renders only what is published                                          | 9 fields, **all null**                                | —                                                       | All of them                                 | **No**                                                |
| **Legal**                  | 4 pages exist                                                                               | All four declare themselves drafts                    | —                                                       | Counsel                                     | **No**                                                |
| **Transaction monitoring** | Two log lines merged in #215; DB state authoritative                                        | —                                                     | —                                                       | —                                           | **Yes, with #215**                                    |
| **Refund**                 | Complete; refund counted once; `refund.created` deliberately moves nothing                  | Automation **off and production-forbidden**           | —                                                       | Fee refundability (GST Q9)                  | **Code yes, policy no**                               |

---

## READY NOW

Requiring no further engineering:

- **Razorpay payment creation on the checkout path.** `PaymentProviderResolver` builds the
  adapter from `RAZORPAY_KEY_ID`/`RAZORPAY_KEY_SECRET`; both are set; a real live order was
  created and read back from the live account.
- **The webhook endpoint.** Live, signature-verified with a timing-safe compare against the raw
  body, deduped on `(provider, providerEventId)`, idempotent at three separate claims, and
  exempt from throttling so a sale spike cannot turn confirmations into 429s.
- **Ticket issuance and money safety.** Only the delivery that flips `PENDING_PAYMENT →
CONFIRMED` issues tickets. A provider amount that disagrees with the booking total refuses to
  issue and raises an audit row. A capture naming no booking is recorded and ignored rather
  than guessed at.
- **Refund mechanics**, including the distinction that cost us a double-count once:
  `refund.created` means accepted-not-paid and moves nothing.
- **OTP security**, for whenever SMS arrives: bcrypt-hashed codes, per-row guess limit applied
  by compare-and-increment, send caps, and a send failure consuming the code so an undelivered
  OTP is not redeemable.
- **Finance/Payout safety.** Execution off, Route off, reversal sweep unset, resolution moves no
  money.

## WAITING ON EXTERNAL PROVIDER

Genuine third-party dependencies, in rough order of lead time:

1. **DLT registration** (TRAI) — PE ID and a registered sender header. Longest lead item on the
   whole list.
2. **An MSG91 account** with the India SMS route enabled, and one approved template per message.
3. **Razorpay webhook secret confirmation** — not obtainable by asking. Razorpay never returns
   the secret, so only a real paid purchase can prove ours matches theirs.
4. **Legal counsel** for terms, privacy, the refund policy and the organizer agreement.
5. **An Indian accountant** for the GST questions.

## WAITING ON SRINIVAS

Concrete and answerable. The first three change money.

1. **GST Q1 — is GST on our fee inclusive or added?** It is added today, so activation raises
   every order (Rs 1.28 on a Rs 100 ticket). This is a price change to real customers.
2. **GST Q10 — who remits the admission GST, us or the organizer?** We currently pay organizers
   from the face value without withholding it. If we are the supplier of admission, settlement
   amounts are wrong today.
3. **GST Q3 — our GST registration state.** Unset in production, and it decides CGST/SGST vs
   IGST on the fee.
4. **`legalName` and `supportEmail`** — the two business details a customer needs in order to
   know who they paid and how to reach them.
5. **The refund and cancellation policy.** Ours currently says we have not decided. Of
   everything on this page, this is the item I would least want to take money against.
6. **Pricing figures** on `/pricing`, the landing preview and the FAQ, all declared placeholders.
7. **Whether `GUEST_BOOKING_ACCESS` may go by SMS.** Its payload is a bearer link, and an SMS is
   a lock-screen notification. The email template already keeps that link out of the subject for
   this reason.
8. **Whether to merge PR #216** (Redis-backed rate limits) and, separately, whether to set
   `THROTTLE_STORAGE=redis`. The default changes nothing, so merging is low risk and switching
   it on is the actual decision.

## ENGINEERING GAPS

Demonstrated, not speculative.

1. **`calculateFees` accepts `taxRules` and would charge inclusive tax twice.** It computes
   `totalMinor = netSubtotal + customerFee + taxMinor`, using `taxMinor` rather than
   `taxAddedMinor`; with a banded rule it throws outright, because it does not forward
   `admissionLines`. **No production caller passes them** — `PricingService.quote` rates tax
   separately and correctly — so this is a loaded gun rather than a live defect. Recommended
   fix: remove `taxRules` from `FeeCalcInput`, or return `taxAddedMinor` and use it. Not changed
   during the freeze; it is shared money code and deserves its own review.
2. **No single correlation id spans the transaction.** The join key is the booking id, which is
   present on every row, and #215 added the two missing log lines. Good enough to diagnose a
   first transaction; not a tracing system, and not worth building one yet.
3. **`settlements.onPaymentSucceeded` is fire-and-forget** (`void`, after the commit). Finance
   can lag a confirmed booking, and a failure there is invisible. Acceptable for a pilot;
   worth a durable hand-off before volume.
4. **The fee bands have gaps** — Rs 199.01-199.99, and the same at 499 and 999, match no band
   and fall back to the nearest below. Benign today (the lower fee is charged) but it is an
   implicit behaviour rather than a chosen one.

### Two defects of my own, found and fixed this sprint

- **The shipped GST seed ran on import.** Exporting `INDIA_GST_RULES` so the rate table could be
  tested meant `main()` executed whenever a test imported it — opening a Prisma client and
  writing `TaxRule` rows into whatever `DATABASE_URL` was set, with `process.exit(1)` on failure
  taking the Jest worker with it. Harmless against a test database and one configuration change
  away from writing tax rules from a test run. Now guarded by `require.main === module`.
- **A test that asserted nothing.** `x === 0 + x - 0`, labelled "THE PROPERTY THAT MAKES
  ACTIVATION SAFE". It is true for every possible value, and the claim it was dressing up is
  false. Replaced with the measured behaviour.

## PRS CREATED

`main` is `e33daa5`. **#215 is merged**; #216 and this branch are open by instruction.

| PR                                                      | Workstream                            | SHA       | Purpose                                                                                                                               | CI        | Merge recommendation                                                                                                                   |
| ------------------------------------------------------- | ------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| [#215](https://github.com/ETicketsGo/etickets/pull/215) | G — observability                     | `7c1e201` | Two log lines so a live payment is traceable                                                                                          | 5/5 green | **MERGED** into `main` as `e33daa5`; trunk CI green, verified by SHA. Takes effect on the next deploy                                  |
| [#216](https://github.com/ETicketsGo/etickets/pull/216) | F — auth throttling                   | `c1727c0` | Redis-backed rate-limit counters, no new dependency, `THROTTLE_STORAGE=memory` default so deploying changes nothing                   | pending   | **Merge when convenient; switch on separately.** Not a launch blocker                                                                  |
| this branch                                             | A, B, D, E — docs + GST/webhook tests | —         | 6 documents, the GST measurement, the seed-import fix, the unattributable-capture tests, and two corrections to the certification doc | pending   | **Merge before the first transaction** — the runbooks are meant to be followed, and the corrected claims are currently wrong on `main` |

---

## FIRST TRANSACTION GATE

`ADDITIONAL BLOCKERS REMAIN`

Blockers only:

1. **No fresh verified database backup.** Newest recovery point is 2026-09-29. This already
   halted an authorized deployment and is the top of the chain.
2. **Production is 144-163 commits behind** and has not been deployed.
3. **The storefront still describes itself as a demo** and still shows `.example` contact
   addresses. Fixed in code on `main`; not live.
4. **`legalName` and `supportEmail` are unset** — a customer cannot tell who they paid or how to
   reach them.
5. **The refund policy is undecided**, in writing, on the page customers will quote.
6. **The GST position is undecided** on two questions that change money (Q1, Q10), and
   production currently charges no GST on INR sales at all.
7. **No customer in India can be sent an SMS**, so phone sign-in — the primary route for this
   market — cannot work.
8. **The webhook secret is unverified**, and only a real paid purchase can verify it.

Items 1-3 are ours and mechanical. Items 4-6 are yours. Item 7 is externally gated. Item 8
resolves itself on the first purchase, provided somebody is watching it.
