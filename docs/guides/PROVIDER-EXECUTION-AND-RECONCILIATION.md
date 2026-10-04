# Provider execution and reconciliation

What actually happens when ETicketsGo moves money to an organizer through a payment provider, and
what it knows afterwards. Traced from the code at `e0ed7c4`, not from intent.

**The question this document exists to answer:** if Razorpay Route is enabled later, can ETicketsGo
execute and reconcile provider movement without guessing about money?

---

## 1. The two money directions, and why they are not equals

There are two external money operations on a settlement:

|                                  | Direction           | Amount               | Durable attempt record      | Outcome model                                       | Status query               | Recovery worker |
| -------------------------------- | ------------------- | -------------------- | --------------------------- | --------------------------------------------------- | -------------------------- | --------------- |
| **Transfer** (`createTransfer`)  | OUT to organizer    | the whole payout     | **none**                    | `COMPLETED \| FAILED`                               | **none**                   | **none**        |
| **Reversal** (`reverseTransfer`) | BACK from organizer | a refund-sized slice | `SettlementReversalAttempt` | `CONFIRMED \| ACCEPTED \| REFUSED \| INDETERMINATE` | `getTransferReversalState` | the sweeper     |

**The reversal path is mature. The transfer path is not.** Every safety mechanism this codebase
built for provider uncertainty — durable intent before the call, a four-way outcome union that
admits "I do not know", a provider status query, a capability-narrowed reconciliation reader, a
backoff sweeper, supersession when an amount changes — exists on the side that moves the _smaller_
amount _back_, and does not exist on the side that sends the _whole payout out_.

That asymmetry is the central finding of this trace. Everything below elaborates it.

---

## 2. The transfer lifecycle, as implemented

`SettlementService.release()`, `apps/api/src/payments/settlement/settlement.service.ts`.

| #   | Step                             | Local write                                                                            | Transaction            | Notes                                            |
| --- | -------------------------------- | -------------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------ |
| 1   | already `TRANSFERRED`?           | none                                                                                   | —                      | idempotent exit                                  |
| 2   | `isReleasableSettlementStatus`   | none                                                                                   | —                      | `APPROVED` or `FAILED` only                      |
| 3   | payout-ledger double-claim check | none                                                                                   | —                      | refuses before any mutation                      |
| 4   | **atomic claim**                 | `status -> TRANSFER_PROCESSING`                                                        | own `updateMany`       | `count !== 1` means another worker won           |
| 5   | provider pre-checks              | may set a blocked state                                                                | own update             | Route flag, connected account                    |
| 6   | compute payable                  | none                                                                                   | —                      | incremental, from `priorTransferredMinor`        |
| 7   | zero payable                     | `TRANSFERRED`, `payableMinor 0`                                                        | own update             | nothing moved, correctly records nothing         |
| 8   | **`adapter.createTransfer`**     | **none**                                                                               | **none open**          | correct: no DB transaction across a network call |
| 9   | persist success                  | `TRANSFERRED`, `providerTransferId`, both money fields incremented, organizer notified | **one** `$transaction` |                                                  |
| 10  | any throw                        | `status -> FAILED`, `failureMessage`                                                   | own update             | audit + admin notification, then rethrows        |

### What is right about it

- The provider call is deliberately outside any transaction. A DB transaction and an HTTP call
  cannot be made atomic and the code does not pretend otherwise.
- The claim at step 4 is a real atomic guard, so two releases cannot overlap.
- Step 9 is one transaction covering the row and the organizer notice, so the notice cannot be
  lost in the window between them.
- Both money fields are atomic increments, so a reversal landing mid-release is not undone.

### What is wrong about it

**(a) No durable record that an attempt was ever made.** Nothing is written before step 8. If the
process dies during the provider call, there is no row anywhere saying ETicketsGo asked a provider
to send money. Compare the reversal path, which commits a `REQUESTED` attempt _before_ calling out
precisely so that a crash leaves something a human or a sweeper can find.

**(b) UNKNOWN is recorded as FAILED.** Step 10 catches everything — a refusal, a timeout, a
connection reset, an unparseable response — and writes `FAILED`. A timeout means the provider may
have moved the money. Recording that as `FAILED` states something the system does not know.

**(c) `TransferResult` cannot express uncertainty.** It is `{ transferId, status: 'COMPLETED' |
'FAILED' }`. Both adapters hardcode `COMPLETED` on any non-throwing response. This is the exact
defect that was found and fixed for reversals — the `reverseTransfer` doc comment says so in as
many words — and it was never fixed for transfers.

**(d) No way to ask what happened.** The contract has `getTransferReversalState(transferId)` and
nothing that asks about a _transfer_. After an ambiguous outcome there is no query to recover with,
and no `transferId` to query with anyway.

---

## 3. Operation identity

```
idempotencyKey = `settlement_${settlement.id}_${settlement.transferredMinor}`
```

Derived from the settlement and its **prior** cumulative transferred amount, which only advances
when step 9 commits. So:

- a retry after a lost write presents the **same** key — the provider may deduplicate;
- a genuine second, incremental release presents a **different** key — correctly a new operation.

That identity is thoughtful. It has two defects.

**(e) The key does not include the amount, but the amount can change.**
`computeSettlementPayable` also depends on `refundsMinor` and `disputesMinor`. A refund landing
between a crash and a retry produces the **same key with a different amount**. Stripe rejects
reuse of a key with different parameters. Razorpay's behaviour is **unverified**.

**(f) The Razorpay adapter silently discards the key.** `RazorpayPaymentProvider.createTransfer`
sends `account`, `amount`, `currency` and `notes`. It does **not** send `idempotencyKey` in any
form. `StripePaymentProvider.createTransfer` passes `{ idempotencyKey: input.idempotencyKey }` to
the Stripe client.

So the entire recovery story — _"a retry presents the same key, the provider deduplicates, the
organizer is not paid twice"_ — is **true for Stripe and false for Razorpay**, and nothing in the
code, the interface or the documentation said so. On Razorpay a retry after an ambiguous outcome
would send a **second transfer**.

This is a statement about **our adapter**, which can be read and tested. It is **not** a claim
about what the Razorpay API does or does not support — that remains unverified.

---

## 4. The capability pattern this codebase already ratified

ADR-043 established that an adapter which cannot prove idempotency does not get automatic
execution:

```
supportsIdempotentVoid    "gates automatic void execution"
supportsIdempotentRefund  "gates AUTOMATIC refund execution - if the adapter cannot prove
                           idempotent refunds, auto-refund stays unavailable for that provider"
supportsPaymentStatusQuery / supportsRefundStatusQuery
                          "enables status recovery for ambiguous outcomes"
```

Real adapters declare `false` unless proven; only the mock declares `true`.

**There is no `supportsIdempotentTransfer` and no `supportsTransferStatusQuery`.** The principle
was applied to voids and to refunds, and never to the operation that sends the largest amount of
money. Extending it to transfers invents nothing.

---

## 5. Crash window matrix

`T` = the `createTransfer` call. "Knows" means what is durably recorded.

|       | Scenario                                             | What ETicketsGo knows              | What it does NOT know  | Retry safe?                          | Query needed? | Durable evidence               | Human? |
| ----- | ---------------------------------------------------- | ---------------------------------- | ---------------------- | ------------------------------------ | ------------- | ------------------------------ | ------ |
| **A** | intent persisted, crash before `T`                   | nothing — **no intent row exists** | whether it ever called | yes (nothing sent)                   | no            | `TRANSFER_PROCESSING` only     | no     |
| **B** | `T` sent, network timeout                            | `FAILED` — **wrong**               | whether money moved    | **only if the adapter deduplicates** | **yes**       | none                           | yes    |
| **C** | provider accepted, crash before step 9               | `TRANSFER_PROCESSING`              | that it succeeded      | same as B                            | **yes**       | none                           | yes    |
| **D** | provider accepted, local tx fails                    | `FAILED` — **wrong**               | same                   | same as B                            | **yes**       | none                           | yes    |
| **E** | provider rejected                                    | `FAILED` — correct                 | —                      | yes                                  | no            | `failureMessage`               | no     |
| **F** | accepted, persisted, notification fails              | `TRANSFERRED`                      | —                      | n/a                                  | no            | same transaction, cannot split | no     |
| **G** | local says transferred, provider later says reversed | `TRANSFERRED`                      | the disagreement       | n/a                                  | yes           | reversal attempts only         | yes    |
| **H** | refund during recovery of an earlier transfer        | both, atomically                   | —                      | yes                                  | no            | attempt row + increments       | no     |
| **I** | duplicate webhook                                    | —                                  | —                      | —                                    | —             | see §7                         | —      |
| **J** | webhook before the sync response is handled          | —                                  | —                      | —                                    | —             | see §7                         | —      |

**A, B, C and D all share one root cause: no durable transfer attempt.** In B and D the row says
`FAILED` when the honest answer is _unknown_. In A and C it says `TRANSFER_PROCESSING` forever,
with nothing to sweep it.

The reversal column of this matrix is entirely different: every one of those windows leaves a row,
and the sweeper's own doc comment enumerates them.

---

## 6. Reconciliation, as implemented

Real but **reversal-only**.

- `reconcileTransferEvidence` compares stored figures against provider evidence.
- `ReconciliationAction` is the repository's own vocabulary: `AGREES`, `CONFIRM`, `MARK_FAILED`,
  `STILL_UNKNOWN`, `OPERATOR_REVIEW`. New code should reuse these rather than invent synonyms.
- `ReversalSweeper` finds `REQUESTED | PROCESSING | UNKNOWN` attempts on a backoff ladder.

Its safety property is structural, not procedural:

> The sweeper is handed a `ProviderReconciliationReader` — an interface with exactly one method,
> which reads. It never receives an adapter that can create a transfer, issue a reversal, or
> refund anything, so the capability is absent rather than merely unused.

`UNKNOWN -> QUERY -> authoritative evidence -> reconcile`, never `UNKNOWN -> resend`. That is the
right model. **It covers reversals only.** There is no transfer equivalent because there is nothing
to sweep.

### `reconciliationMismatch` — CLOSED

It is gone. It had one writer (a hardcoded `false`) and one reader, so a third of `needsPerson`
was permanently dead.

`SettlementReconciliationFinding` is now the durable record of an unresolved reconciliation
problem, and the Finance read derives `openFindingCount` from it — **one** source of truth for
"does this need attention", not a second copy that can go stale. A resolved finding stops
counting; the row stays, because the row is the evidence.

The two product questions it was blocked on were answered: an authorized operator
(`ADMIN`/`SUPER_ADMIN` + `PAYMENT_ADMIN`) may disposition a finding, recording actor, time,
classification, a mandatory reason and — where the disposition claims a provider fact — the
reference they saw. **Disposition moves no money.**

## 7. Webhooks

Two provider webhook surfaces exist (`stripe/`, `razorpay/`), each with controller, service and
processor, behind `webhook-router.service.ts`.

This half of the system is in much better shape than the transfer path, and the ingestion order is
already the right one:

```
verify the signature  ->  resolve a dedup identity  ->  persist RECEIVED  ->  process
```

| Provider-neutral property                           | State       | Evidence                                                          |
| --------------------------------------------------- | ----------- | ----------------------------------------------------------------- |
| signature bound to the exact raw bytes              | implemented | `verifySignedEnvelope` HMACs `rawBody`, timing-safe compare       |
| fail closed: an unverified payload persists nothing | implemented | verification precedes every DB call                               |
| stable dedup identity                               | implemented | event-id header, falling back to a SHA-256 of the payload         |
| duplicate delivery not reprocessed                  | implemented | claim on the stored row being `PROCESSED`/`PROCESSING`            |
| unfinished delivery retried in place                | implemented | `RECEIVED`/`FAILED` updates the row rather than creating a second |
| unhandled event type ignored, not dropped           | implemented | processor marks `IGNORED`                                         |
| poison event dead-lettered                          | implemented | processor `MAX_ATTEMPTS`                                          |
| processing failure does not fail ingestion          | implemented | the row is committed first; the sweep retries                     |

What was missing was not the behaviour but the **proof of the ingestion step**: signature rejection
was tested at the adapter and event handling at the processor, with nothing covering the step
between - the one that decides whether an unauthenticated payload can leave a row behind. Stripe
had `stripe-webhook.service.spec.ts`; Razorpay had no equivalent. It does now, using the real
adapter so the HMAC check is genuine rather than a double that always agrees.

**Still Razorpay-specific and not claimed here:** that Razorpay signs what we think it signs, which
events it actually sends, its redelivery cadence, and whether it can deliver out of order. Those
need verified provider documentation or a sandbox. Nothing in this repository infers them.

---

## 8. Sweeper status

**OFF, and it stays off.** Reviewed, not enabled. If enabled it would reconcile reversals only,
and could not send money because it is not given an adapter that can.

---

## 9. What this trace concludes

Ordered by financial consequence:

1. **No durable transfer attempt record.** Root cause of crash windows A–D.
2. **The Razorpay adapter discards the idempotency key**, so the documented recovery property does
   not hold for it. A retry could pay an organizer twice.
3. **UNKNOWN is recorded as FAILED**, which is a statement the system cannot support.
4. **`TransferResult` cannot express uncertainty**, so (3) cannot even be fixed at the call site
   without changing the contract.
5. **No transfer status query**, so there is no recovery path from an ambiguous outcome.
6. **No `supportsIdempotentTransfer` capability**, so nothing stops automatic execution on an
   adapter that cannot deduplicate.
7. **`reconciliationMismatch` is a dead contract input.**

None of these require knowing anything about Razorpay to fix. (2) is a fact about our own adapter;
whether the Razorpay _API_ offers idempotency is a separate, still-open question.

---

## 10. What has been fixed so far

### Transfer idempotency capability and the replay gate

Findings (2) and (6) are closed. `supportsIdempotentTransfer` and `supportsTransferStatusQuery`
join the capability model, declared per adapter against what the adapter's code actually sends:

| Adapter                     | `supportsIdempotentTransfer` | Evidence                                                                           |
| --------------------------- | ---------------------------- | ---------------------------------------------------------------------------------- |
| Stripe                      | `true`                       | passes `{ idempotencyKey }` to the client; contract-tested                         |
| Razorpay                    | `false`                      | sends only account/amount/currency/notes; contract-tested that no identity appears |
| Mock                        | `true`                       |                                                                                    |
| PayPal, Square, Unavailable | `false`                      | no transfer support wired                                                          |

`release()` now refuses to **replay** a transfer whose outcome is unknown on an adapter that
cannot prove deduplication. "Replay" is `status === 'FAILED' && !providerTransferId` — a prior
attempt that never yielded a transfer id. The settlement goes `BLOCKED` with a reason, the
provider is **not called**, and no money can be sent twice.

A **first** attempt is not gated: nothing has been sent, so there is nothing to double. Gating it
would stop every Razorpay payout rather than only the unsafe replay.

Proven in `release-writer.integration-postgres.spec.ts` (writer-driven, real PostgreSQL) and
`transfer-idempotency.contract.spec.ts` (adapter contract). Removing the gate fails exactly one
test, and that failure is a second transfer being sent.

The gate converts (3)'s consequence from _duplicate money_ to _a blocked settlement a person must
resolve_, which is a far better failure, but it does not by itself make the system able to say
"unknown".

### Durable transfer attempts, and an honest UNKNOWN

Findings (1) and (3) are closed. `SettlementTransferAttempt` mirrors the reversal attempt table
that has existed since `20261001194912`, because it is the same problem on the side that moves the
larger amount.

The order is now the one the reversal path has always used:

```
1. write the attempt REQUESTED and COMMIT, before the provider is called
2. call the provider, with no transaction open
3. record what the answer proved
4. move money ONLY on a proven success
```

- **Step 1 closes crash windows A-D.** A process that dies inside `createTransfer` now leaves a
  `REQUESTED` row saying ETicketsGo asked for money to move. Previously nothing distinguished that
  from never having tried.
- **Step 3 records `UNKNOWN`, not `FAILED`.** Every error lands in one catch - a refusal, a
  timeout, a reset, an unreadable response - and at that point nothing separates _"the provider
  said no"_ from _"the provider may have sent the money and we lost the answer"_. `UNKNOWN` is the
  honest state, and the one the reversal side already uses.
- The **settlement** keeps its existing `FAILED` status, which is a true statement about this
  release not completing. Changing its meaning would reach far outside this path. The attempt row
  is where the uncertainty lives.
- On success **step 3 runs in the same transaction as the money**, so an attempt saying
  `SUCCEEDED` while the settlement disagrees cannot be produced by our own write ordering.

### Operation versus attempt

`idempotencyKey` is deliberately **not unique** on the attempt table. It identifies the
**operation** - one settlement at one prior transferred amount - and is stable across replays on
purpose, because that is what makes recovery possible. Each **attempt** at that operation is a row.
Rows sharing a key are attempts at the same external money movement.

That also makes finding (e) detectable, which closes it. A replay presents the same identity, but
the amount is computed from `refundsMinor` and `disputesMinor` too, so a refund landing between a
crash and a retry produces **the same identity carrying a different amount**.

Rather than depend on what a given provider does with that - Stripe rejects it, Razorpay is
unverified - ETicketsGo now refuses it itself. A release whose payable differs from a prior attempt
under the same identity is `BLOCKED` before anything leaves the process. A changed amount is a
_different operation_, and reusing one identity for two requests would make them indistinguishable
to the provider and to us.

### A structured outcome, so uncertainty is reported rather than inferred

Finding (4) is closed. `TransferResult` is gone; `createTransfer` now returns a `TransferOutcome`
with the same shape `ReversalOutcome` has had since it was built:

| Arm             | What it proves                                                                         |
| --------------- | -------------------------------------------------------------------------------------- |
| `ACCEPTED`      | the provider took the instruction and gave a reference. **Not** that the money settled |
| `REFUSED`       | the provider declined **without acting**. Authoritative, and carries `retryable`       |
| `INDETERMINATE` | we cannot say. The provider may have moved money while our answer was lost             |

There is deliberately no `CONFIRMED`: neither adapter reads anything proving the organizer has the
money, and claiming more would be the hardcoded-`COMPLETED` mistake in a new shape.

Classification reuses the reversal machinery rather than inventing a second one. The rule is
unchanged and deliberately asymmetric:

> An error becomes `REFUSED` only when it proves the provider did NOT act. Anything else is
> `INDETERMINATE`.

`REFUSED` invites a retry, and retrying a transfer that already succeeded pays the organizer their
whole payout twice. `INDETERMINATE` invites a question, which is slower and cannot move money by
mistake. Stripe gets the documented authoritative-refusal set; **every Razorpay error stays
`INDETERMINATE`**, because its Route taxonomy is not evidenced anywhere here - a placeholder for
evidence, not for effort.

Two consequences in `release()`:

- a `REFUSED` outcome records the attempt `FAILED`, not `UNKNOWN`. The question is settled, so
  there is nothing for a reconciliation worker to resolve and nothing to dilute a queue of real
  uncertainty with.
- **the replay gate now reads attempt evidence instead of settlement status.** Those were the same
  thing while every failure produced `FAILED` with no transfer id. They are not any more: a
  settlement refused by the provider is replayable, and gating it would strand a payout - a closed
  destination account, say - behind manual review forever on any provider that cannot deduplicate.
  Settlements predating the attempt table have no rows, so for those the old coarse test remains
  the only evidence and stays conservative.

**Still open:** (5) no transfer status query, so an `UNKNOWN` attempt cannot yet be resolved by
asking the provider - which is also why there is no transfer sweeper, because there would be
nothing safe for it to call; (7) `reconciliationMismatch`.
