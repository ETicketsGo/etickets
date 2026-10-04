# Provider execution readiness

> **The question:** if Razorpay Route is enabled later, can ETicketsGo execute and reconcile
> provider movement without guessing about money?
>
> **The answer today:** every part of that sentence that is ETicketsGo's to build now exists. The
> transfer contract reports uncertainty instead of inferring it, a durable attempt records every
> request, a disagreement is a row with a lifecycle rather than a log line, reconciliation
> classifies evidence without being able to move money, and an operator has one place to find
> money nobody can account for.
>
> What remains is not architecture. It is two sentences from Razorpay - see
> [RAZORPAY-SANDBOX-HANDOFF.md](./RAZORPAY-SANDBOX-HANDOFF.md).

Assessed at `b35a2ff`. Companion to
[PROVIDER-EXECUTION-AND-RECONCILIATION.md](./PROVIDER-EXECUTION-AND-RECONCILIATION.md), which
traces the lifecycle this assesses.

---

## 1. The Razorpay questions

**No committed artifact in this repository enumerates "the five Razorpay questions."** That phrase
appears in working notes, not in any ADR, readiness report, issue or test. Rather than reconstruct
a list from memory and present it as the repository's, this records the Razorpay-specific unknowns
that **are** evidenced in the code and docs, with their sources.

| #   | Question                                                                                                | Current answer                                | Repository evidence                                                                                  | Needs Razorpay?             | Blocks                                                                           |
| --- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------- | -------------------------------------------------------------------------------- |
| 1   | Does the Razorpay API support an idempotency identity on Route transfers?                               | **UNKNOWN**                                   | `razorpay-payment.provider.ts` sends none; `transfer-idempotency.contract.spec.ts` proves that       | **Yes** — API documentation | automatic retry of an ambiguous transfer; `supportsIdempotentTransfer`           |
| 2   | What does Razorpay do with a reused identity carrying a different amount?                               | **UNKNOWN**, and no longer depended on        | we refuse to send it ourselves (#200)                                                                | Yes                         | nothing any more                                                                 |
| 3   | Are Route reversals synchronous?                                                                        | **UNKNOWN**, and deliberately not depended on | `razorpay-payment.provider.ts` doc comment: completion never comes from the synchronous answer       | Yes                         | nothing — completion comes from the webhook or from cumulative `amount_reversed` |
| 4   | Can a Route transfer's status be queried after an ambiguous result?                                     | **UNKNOWN**                                   | no adapter implements any transfer status query; `supportsTransferStatusQuery` is `false` everywhere | **Yes**                     | resolving an `UNKNOWN` attempt; any transfer sweeper                             |
| 5   | Which Route webhook events does Razorpay actually send, in what order, and how often does it redeliver? | **UNKNOWN**                                   | processor handles `transfer.reversed`; ordering and cadence untested against the provider            | **Yes**                     | out-of-order and redelivery guarantees beyond our own dedup                      |
| 6   | Is Route activated, with linked accounts KYC-complete?                                                  | **NO**                                        | `RAZORPAY-PRODUCTION-CHECKLIST.md` §1, all unchecked                                                 | Yes — account configuration | every real payout                                                                |

Questions 2 and 3 were **removed as blockers by design rather than answered**: the system no longer
depends on either. That is the pattern to repeat — where a provider's behaviour is unknown, prefer
not needing to know it.

**No Stripe behaviour anywhere in this table is offered as evidence for Razorpay.**

---

## 2. What changed in this workstream

| PR                                                      | Defect                                                                                                                                                          | Financial consequence                                                                       | Falsification                                                                 |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| [#199](https://github.com/ETicketsGo/etickets/pull/199) | The Razorpay adapter accepted an `idempotencyKey` and discarded it, while the documented recovery story assumed it was honoured                                 | **duplicate payout** on retry after a timeout                                               | removing the gate fails exactly 1 test, and that failure is a second transfer |
| [#200](https://github.com/ETicketsGo/etickets/pull/200) | Nothing was written before `createTransfer`; four crash windows were indistinguishable from "never tried", and every ambiguous outcome was recorded as `FAILED` | money possibly sent with **no record it was asked for**; uncertainty misreported as failure | `UNKNOWN`→`FAILED` fails 2; removing the amount-drift refusal fails 1         |
| [#201](https://github.com/ETicketsGo/etickets/pull/201) | The Finance read counted unresolved reversals only, so money that may have gone **out** raised no flag                                                          | an organizer possibly holding unaccounted money, invisible                                  | dropping transfer attempts from the count fails exactly 1                     |
| [#202](https://github.com/ETicketsGo/etickets/pull/202) | Ingestion had no spec between the adapter and the processor                                                                                                     | an unverified payload could have left a retryable row                                       | verifying after persisting fails exactly 3                                    |

---

## 3. The sweeper, if it were ever enabled

**It is OFF.** `SETTLEMENT_REVERSAL_RECONCILE_ENABLED` defaults false, `sweep()` returns empty when
disabled, and every config in the repository sets it `false` or leaves it commented out. It is
registered in the worker but gated. Nothing in this workstream enabled it.

If enabled, it would sweep **reversal** attempts only, on a backoff ladder, and its safety is
structural rather than procedural:

> It is handed a `ProviderReconciliationReader` — one method, which reads. It never receives an
> adapter that can create a transfer, issue a reversal, or refund anything, so the capability is
> absent rather than merely unused.

`UNKNOWN -> QUERY -> authoritative evidence -> reconcile`, never `UNKNOWN -> resend`. That is the
right model and it is already enforced by a type rather than a rule.

**There is no transfer sweeper, and one must not be written yet.** A sweeper's first act is to
_observe_, and for transfers there is nothing safe to call — no adapter implements a transfer
status query. A transfer sweeper built today could only guess or resend, and resending is the one
thing it must never do. Question 4 above is its prerequisite.

---

## 4. `derivedPosition` — decision: leave unwired

`derivedPosition(releasedMinor, attempts)` derives `TRANSFERRED | PARTIALLY_REFUNDED | REVERSED`
and has no production caller. Nothing sets a settlement to the latter two.

**Recommendation: do not wire it.** Reasons, in order:

1. **It would change no behaviour.** Both consumers of settlement status —
   `SETTLEMENT_CLAIMED_STATUSES` (the one-path payout boundary) and `RELEASED_STATUSES` (the
   provider producer) — already contain all four statuses. A settlement moving from `TRANSFERRED`
   to `REVERSED` stays claimed and stays released. There is no correctness gap to close.
2. **Monetary evidence is already authoritative.** Movement is derived from `releasedMinor`,
   `transferredMinor` and confirmed reversals, never from status. Introducing a second, stored
   expression of the same fact creates a way for them to disagree.
3. **A stored status goes stale; the money does not.** The same objection that rules out a
   `reconciliationMismatch` boolean applies here.

It is worth keeping rather than deleting: it is correct, tested, and is the natural source for a
human-readable position if an operator view ever needs one. Note that it was _wrong_ until
[#198](https://github.com/ETicketsGo/etickets/pull/198) — with `releasedMinor` stuck at `0` its
`releasedMinor > 0` guard made `REVERSED` unreachable, so a fully reversed settlement would have
read `PARTIALLY_REFUNDED`. It became correct as a side effect of that fix.

---

## 5. Readiness gate

### A. Internal accounting — what is owed · **YES**

Platform entitlement is `Payout.netMinor` with decomposition from `PayoutAllocation`; provider
entitlement is `Settlement.grossSalesMinor`. Legacy payouts report their missing breakdown as a
limitation rather than a zero.

### B. Internal movement — what left, came back, remains out · **YES, for recorded movement**

`transferredMinor == releasedMinor - Σ(confirmed reversals)` holds, both fields are atomic
increments, and the invariant survives a reversal landing mid-release. Rows released before #198
have no stored figure and are **not** backfilled; they report `MOVEMENT_NOT_RECORDED` rather than
inventing one.

### C. Operation identity · **YES internally, NOT end-to-end**

An operation is one settlement at one prior transferred amount. Attempts group under that identity;
a replay presents it again on purpose; a changed amount is a **different** operation and is refused
rather than silently reusing the old one.

**The caveat is the whole of question 1:** the identity only reaches the provider through an adapter
that sends it. Stripe does. Razorpay does not. That is declared in capabilities, contract-tested,
and enforced by the replay gate — it is not left as an assumption.

### D. Unknown outcome · **YES**

`SettlementTransferAttempt.UNKNOWN`. Previously every ambiguous result was written as `FAILED`.

The contract now reports it. `createTransfer` returns a `TransferOutcome` of `ACCEPTED` /
`REFUSED` / `INDETERMINATE`, so a refusal the provider made before acting is distinguishable from
a timeout where it may have acted anyway - and only the second is recorded as `UNKNOWN`. The
transfer contract is no longer a generation behind the reversal one.

### E. Recovery from provider-success + local-write-failure · **PARTIAL, and safe either way**

- Where the adapter proves idempotent replay: the key is derived from the prior transferred amount,
  which only advances on commit, so a retry presents the **same** identity. Proven stable across
  that window.
- Where it does not: the replay is **refused**, the settlement is `BLOCKED` with a reason, and a
  person resolves it.

No path sends money twice. But automatic recovery exists only where idempotency is proven, so for
Razorpay today the "recovery" is a human.

### F. Reconciliation · **PARTIAL - and the remainder is Razorpay's**

Both directions now have an engine, durable evidence and a reader that cannot move money.
Transfers gained `classifyTransferEvidence` (total over every provider disposition), a durable
`SettlementReconciliationFinding` with a stable identity, and `TransferReconciliationService`,
which is constructed with Prisma alone and therefore has no means to move money at all.

Disagreement is never silently repaired, and that is now a tested property rather than a
convention: letting reconciliation "catch the ledger up" on a `SENT` answer fails a real-Postgres
test asserting every money column is unchanged.

`reconciliationMismatch` is answered: it was option (C), an event, and it now exists as a finding
with an OPEN/RESOLVED lifecycle. The two product questions are unchanged - who may resolve a money
disagreement, and whether resolution must cite provider evidence - so the resolution COLUMNS exist
and nothing writes them.

What is missing is the one thing we cannot build: a provider that can be asked.

### G. Webhooks · **YES provider-neutrally**

Fail-closed verification before any write, stable dedup identity with a payload-hash fallback,
redelivery not reprocessed, unfinished delivery retried in place, unhandled events ignored not
dropped, poison events dead-lettered, processing failure not failing ingestion. All proven.

Razorpay-specific semantics (question 5) remain unverified.

### H. Sweeper · **It would reconcile first, and it stays OFF**

See §3. It cannot move money by construction. No transfer sweeper exists, and none should be built
before question 4 is answered.

### I. Operator · **YES, for finding it**

Visible today: `BLOCKED` with a specific `blockedReason` for both refusal paths; `ATTENTION_REQUIRED`
in Unified Finance for any settlement with an unresolved attempt in either direction; audit records
for blocks, mismatches and transfer failures; admin notification on failure and mismatch.

`GET admin/payments/unresolved-money` now answers the question directly: unresolved transfers,
open findings and blocked payouts, oldest first, with age, on the existing payment-admin
authorization.

**Deliberately read-only.** No "mark paid", no "force success", no "retry transfer", no "resolve".
Each of those is a financial decision and `who may declare money correct` has no answer yet.

**Missing:** a UI. The endpoint is the read model; no screen was invented.

### J. What genuinely needs Razorpay

Questions 1, 4, 5 and 6 in §1: transfer idempotency support, transfer status query, webhook event
set/ordering/redelivery, and Route activation with KYC-complete linked accounts.

---

## 6. Certifications

Each stands alone. None implies another.

| Certification                                            | Status                                                          | Evidence boundary                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UNIFIED FINANCE PRODUCER CERTIFIED — PLATFORM`          | **GRANTED**                                                     | unchanged by this workstream                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `UNIFIED FINANCE PRODUCER CERTIFIED — PROVIDER MOVEMENT` | **GRANTED**, with the named `reconciliationMismatch` limitation | writer-driven real PostgreSQL; pre-fix rows report a limitation rather than a figure                                                                                                                                                                                                                                                                                                                                                                       |
| `PROVIDER OPERATION MODEL CERTIFIED`                     | **GRANTED**                                                     | ETicketsGo's own model: identity defined, attempts durable, amount drift refused, replay gated by declared capability. Internal evidence only — it does **not** certify that any provider honours the identity we send                                                                                                                                                                                                                                     |
| `PROVIDER RECONCILIATION MODEL CERTIFIED`                | **GRANTED for the model, NOT for any provider**                 | the classifier, the durable finding with a stable identity, and the no-silent-repair property are proven against real PostgreSQL. It certifies that ETicketsGo can consume provider evidence safely — **not** that any provider can supply it. No adapter implements `getTransferState`                                                                                                                                                                    |
| `PROVIDER RECOVERY MODEL CERTIFIED`                      | **NOT GRANTED**                                                 | recovery is automatic only where idempotent replay is declared, and no real provider declares it. Everywhere else recovery is a person. Safe, but a queue is not a recovery model                                                                                                                                                                                                                                                                          |
| `OPERATOR MONEY-EXCEPTION VISIBILITY READY`              | **GRANTED (backend)**                                           | one authorized, tenant-scoped, read-only endpoint covering unresolved transfers, open findings and blocked payouts, with age. No UI                                                                                                                                                                                                                                                                                                                        |
| `RAZORPAY EXECUTION READY FOR SANDBOX`                   | **NOT CLAIMED**                                                 | closer, and for a different reason than before. The internal architecture is now built and tested; what blocks it is that our Razorpay adapter sends no idempotency identity and implements no status query, and **neither can be written without Razorpay telling us how**. The blockers are now genuinely provider-side, but they are not mere configuration, so the claim is withheld. See [RAZORPAY-SANDBOX-HANDOFF.md](./RAZORPAY-SANDBOX-HANDOFF.md) |
| `RAZORPAY EXECUTION CERTIFIED`                           | **NOT CLAIMED**                                                 | no external Razorpay execution is authorized, and none occurred                                                                                                                                                                                                                                                                                                                                                                                            |

---

## 7. The shortest path to sandbox readiness

In order, and none of it requires moving money:

1. **Answer question 1.** If Razorpay supports an idempotency identity on transfers, send it and
   flip `supportsIdempotentTransfer`; the replay gate then permits automatic recovery. If it does
   not, the gate is the permanent answer and that should be stated, not worked around.
2. **~~Add `getTransferState` to the contract~~ - done.** The seam, the classifier, the durable
   finding and the operator queue are all built and tested. What is still missing is Razorpay's
   answer, and it is a sharper question than it looked: not _"can you query a transfer"_ but
   _"can you find one by something WE supplied"_, because the transfers worth asking about are
   exactly the ones where Razorpay never gave us an id.
3. ~~Give `TransferResult` the shape `ReversalOutcome` already has~~ - **done**. `TransferOutcome`
   reports `ACCEPTED` / `REFUSED` / `INDETERMINATE`, and the replay gate now reads attempt
   evidence rather than settlement status.
4. **Get the two product answers** on reconciliation findings (§`reconciliationMismatch`).
5. ~~Build the operator queue~~ - **done**. `GET admin/payments/unresolved-money`, read-only.

Steps 2, 3 and 5 were the provider-neutral ones. All three are done. Step 1 and the second half
of step 2 are questions for Razorpay; step 4 is a question for the business.

---

## 8. FROZEN for controlled launch

This workstream is closed. Everything below is settled; what remains is listed as EXTERNAL,
POST-LAUNCH or OPTIONAL and nothing is vague.

| Area                          | Status                                          |
| ----------------------------- | ----------------------------------------------- |
| Finance accounting            | **CLOSED** for controlled launch                |
| Provider movement model       | **CLOSED** for controlled launch                |
| Reconciliation model          | **CLOSED** provider-neutrally                   |
| Operator exception handling   | **CLOSED** (backend; no UI)                     |
| Automated payout architecture | **READY BUT DISABLED**                          |
| Automated payout execution    | **DISABLED** — `PAYOUT_EXECUTION_ENABLED=false` |
| Customer ticket sales         | **NOT BLOCKED** by any of the above             |

Items that were open and are now answered:

- `reconciliationMismatch` — removed; attention derives from OPEN findings
- manual resolution — implemented, authorized, evidence-conditional, moves no money
- `derivedPosition` — removed; position is read off the money
- transfer observation worker — built, cannot move money, **OFF**
- payout kill switch — `PAYOUT_EXECUTION_ENABLED`, default OFF, provider-neutral
- integrated lifecycle — certified end to end against real PostgreSQL

**Remaining, all external:** whether Razorpay supports transfer idempotency; whether a transfer
can be found by an identifier we supplied; its error taxonomy; its Route webhook set, ordering
and redelivery; Route activation and KYC. See
[RAZORPAY-SANDBOX-HANDOFF.md](./RAZORPAY-SANDBOX-HANDOFF.md).

**Remaining, product:** there is no first-class "record an external settlement" operation, and no
operation that catches the ledger up after a person establishes what a provider did. Both are
deliberate — nobody has decided who may perform them. See
[PAYOUT-LIFECYCLE.md](./PAYOUT-LIFECYCLE.md) §7 and §8.

**Remaining, post-launch:** an operator UI over the money-exception endpoint.
