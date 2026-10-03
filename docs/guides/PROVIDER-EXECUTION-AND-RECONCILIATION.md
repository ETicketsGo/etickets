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

### `reconciliationMismatch`

`unified-finance.service.ts` hardcodes it `false`, with a comment saying no column records it. It
participates in `needsPerson`, so one of the three triggers for "a person must look at this" is
permanently dead. See §9.

---

## 7. Webhooks

Two provider webhook surfaces exist (`stripe/`, `razorpay/`), each with controller, service and
processor, behind `webhook-router.service.ts`. Assessed separately in the webhook work; the
provider-neutral concerns are signature boundary, duplicate delivery, ordering, unknown entity
references and tenant association.

Razorpay signature semantics must come from verified provider documentation, not from inference.

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

**Still open from the list above:** (1) no durable transfer attempt record, (3) UNKNOWN recorded as
FAILED, (4) `TransferResult` cannot express uncertainty, (5) no transfer status query, (7)
`reconciliationMismatch`. The gate converts (3)'s consequence from _duplicate money_ to _a blocked
settlement a person must resolve_, which is a far better failure, but it does not make the system
able to say "unknown".
