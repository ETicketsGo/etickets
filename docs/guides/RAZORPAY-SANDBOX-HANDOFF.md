# Razorpay sandbox handoff

What we need **from Razorpay** before organizer payouts can be tested, and why each item matters.

Assessed at `c32c0d6`. **Do not execute this checklist as part of any autonomous work** — every item
needs a person with access to Razorpay.

> Nothing in this document is an answer. Where a cell says UNKNOWN, it means no evidence exists in
> this repository, and no Stripe behaviour is offered as a substitute.

---

## How to read the columns

- **Depends on** — the internal capability that is currently inert without this answer.
- **Safe without it?** — whether ETicketsGo behaves safely if we never get an answer. In every
  case the fallback is `BLOCK` or a person; nothing degrades into sending money.
- **Blocks sandbox / production** — whether payouts can be _exercised_ / _run for real_ without it.

---

## 1. Transfer idempotency

|                       |                                                                                                                                                                |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Question**          | Does the Route transfer API accept an idempotency identity, and under what header or field? If a key is replayed with a **different amount**, what does it do? |
| **Why we need it**    | Our adapter currently sends no identity at all, so a replayed request would create a **second transfer** and pay an organizer twice.                           |
| **Depends on**        | `supportsIdempotentTransfer`, which gates automatic replay of a transfer whose outcome is unknown. False for Razorpay today.                                   |
| **Safe without it?**  | **Yes.** The replay is refused and the settlement is `BLOCKED` for a person. Safe, but every ambiguous payout becomes manual.                                  |
| **Blocks sandbox**    | No — a first attempt works.                                                                                                                                    |
| **Blocks production** | **Effectively yes** at any volume: without it, every timeout is manual work on real money.                                                                     |

If the answer is "Razorpay does not offer this", say so explicitly and the gate becomes the
permanent documented behaviour rather than a gap.

## 2. Looking a transfer up — the important one

|                       |                                                                                                                                                                                                                                                       |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Question**          | Can a Route transfer be **found by an identifier we supplied** — the idempotency key, `transfer_group`, or `notes` — rather than only by the `transfer_id` Razorpay returns?                                                                          |
| **Why we need it**    | This is the whole difficulty. `providerTransferId` is written **only when Razorpay answers**. The transfers we need to ask about are exactly the ones where it did not, so looking up "transfer `trf_abc`" is impossible: we never learned `trf_abc`. |
| **Depends on**        | `getTransferState(lookup)` and `supportsTransferStatusQuery`. The seam, the classifier and the finding model are all built; no adapter can implement it until this is answered.                                                                       |
| **Safe without it?**  | **Yes.** Reconciliation records `CANNOT_BE_ASKED` and the money stays visible in the operator queue. Safe, but uncertainty can never be resolved automatically.                                                                                       |
| **Blocks sandbox**    | No.                                                                                                                                                                                                                                                   |
| **Blocks production** | **Yes, in practice.** Without it there is no recovery from an ambiguous transfer except a human reading the Razorpay dashboard.                                                                                                                       |

Secondary: is such a lookup **immediately consistent**? If a transfer can be absent from a lookup
moments after being created, `NOT_FOUND` can never be read as "nothing happened" — which is how we
already treat it, and we need to know whether that caution is permanent.

## 3. Error taxonomy

|                       |                                                                                                                                                                                                          |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Question**          | Which Route transfer errors prove Razorpay did **not** act, and which leave it possible that it did?                                                                                                     |
| **Why we need it**    | `razorpayTransferFailure` classes **every** error as `INDETERMINATE`, because we cannot tell the two apart. Correct but costly: an authoritative refusal is treated as uncertainty and goes to a person. |
| **Depends on**        | The `REFUSED` arm of `TransferOutcome` for Razorpay. The arm exists and Stripe uses it.                                                                                                                  |
| **Safe without it?**  | **Yes**, and deliberately so — the asymmetry is chosen. A refusal wrongly called uncertain costs a question; uncertainty wrongly called a refusal costs a duplicate payout.                              |
| **Blocks sandbox**    | No.                                                                                                                                                                                                      |
| **Blocks production** | No, but it is the difference between a manageable exception queue and a noisy one.                                                                                                                       |

## 4. Webhooks

|                       |                                                                                                                                                                                                |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Question**          | Which transfer-related events does Route send (`transfer.processed`, `transfer.failed`, `transfer.reversed`, others)? What are the ordering guarantees, if any? What is the redelivery policy? |
| **Why we need it**    | Our ingestion is proven fail-closed, deduplicated and retry-in-place **provider-neutrally**. What is unverified is which events actually arrive, in what order, and how often.                 |
| **Depends on**        | `RazorpayWebhookProcessor` dispatch. `transfer.reversed` is handled; the others are not mapped.                                                                                                |
| **Safe without it?**  | **Yes.** An unhandled event is marked `IGNORED`, never dropped, and a duplicate cannot be reprocessed.                                                                                         |
| **Blocks sandbox**    | No.                                                                                                                                                                                            |
| **Blocks production** | **Yes** — without `transfer.processed` / `transfer.failed`, an accepted transfer never reaches a confirmed state from the provider side.                                                       |

Also needed: the exact signature contract for Route events (same `X-Razorpay-Signature` HMAC over
the raw body as payment events?), confirmed from documentation rather than assumed.

## 5. Reversals under Route

|                       |                                                                                                                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Question**          | Are Route reversals synchronous? Does the reversal response carry anything proving the money came back? Is the transfer's cumulative `amount_reversed` authoritative and immediately consistent? |
| **Why we need it**    | `razorpayReverseTransfer` already refuses to claim `CONFIRMED` from a response with no status field, and completion is taken from the webhook or from cumulative `amount_reversed`.              |
| **Depends on**        | `getTransferReversalState`, which is implemented and reads `amount_reversed`.                                                                                                                    |
| **Safe without it?**  | **Yes** — this was deliberately designed not to need the answer.                                                                                                                                 |
| **Blocks sandbox**    | No.                                                                                                                                                                                              |
| **Blocks production** | No.                                                                                                                                                                                              |

## 6. Account state

|                       |                                                                                                                                                     |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Question**          | Is Route activated on the platform account? Are linked accounts KYC-complete and payout-enabled? Does Test Mode support Route transfers end to end? |
| **Why we need it**    | `RAZORPAY_ROUTE_ENABLED` is `false` in every environment, and `release()` blocks with a clear reason when a linked account is missing.              |
| **Depends on**        | Every real payout.                                                                                                                                  |
| **Safe without it?**  | **Yes** — nothing is attempted.                                                                                                                     |
| **Blocks sandbox**    | **Yes.**                                                                                                                                            |
| **Blocks production** | **Yes.**                                                                                                                                            |

See `docs/payments/RAZORPAY-PRODUCTION-CHECKLIST.md` §1 for the operational steps.

---

## What we are NOT asking for

Deliberately absent, because the architecture no longer depends on them:

- **What Razorpay does with a reused identity carrying a different amount.** ETicketsGo refuses to
  send one: a changed amount is a different operation, and the settlement is `BLOCKED` first.
- **Whether a reversal response proves completion.** Completion never came from the synchronous
  answer.

Where a provider's behaviour is unknown, the better move was to stop needing to know it. Two
questions left this list that way.

---

## The shape of the answer we want

For items 1 and 2, a sentence each is enough to unblock real work:

> _"Route transfers accept `<header/field>` as an idempotency key; replaying it with different
> parameters returns `<behaviour>`."_

> _"A Route transfer can be fetched by `<identifier>`; it is / is not immediately consistent after
> creation."_

Everything that consumes those answers is already written and tested.
