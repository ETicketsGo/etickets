# Settlement release: the actual state machine

**Why this document exists.** `Settlement.releasedMinor` was read by four call sites and written by
none. Before changing a field in the money path, this recorded what the code actually did, traced
from `apps/api/src/payments/settlement/settlement.service.ts` at `825a36ba` — not what the schema
comment said it did.

> **Outcome.** Sections 1–7 describe the state **before** the fix and are kept as the trace that
> justified it. Two changes followed, both argued in §8:
>
> 1. `release()` now records `releasedMinor: { increment: payable.payableMinor }` in the same
>    transaction that increments `transferredMinor`.
> 2. The two legacy fallbacks reconstruct the figure **exactly** —
>    `transferredMinor + Σ(confirmed)` — instead of understating it as bare `transferredMinor`.
>
> Proven by `release-writer.integration-postgres.spec.ts`, which drives the real service against
> real PostgreSQL. Rows released before the fix are **not** backfilled (§9).

## 1. The two money fields

| Field              | Schema intent                                                        | Written by                |
| ------------------ | -------------------------------------------------------------------- | ------------------------- |
| `releasedMinor`    | "Total ever transferred OUT to the organizer, **never decremented**" | **nothing**               |
| `transferredMinor` | What the organizer still holds; moves **both** ways                  | `release()` +, reversal − |

The schema states the invariant that ties them:

```
transferredMinor == releasedMinor − Σ(confirmed reversals)
```

**Half of it is implemented.** The reversal decrements; the release never increments.

## 2. `release()` — the write path, in order

1. **Idempotent exit.** Already `TRANSFERRED` → return unchanged.
2. **Status guard.** `isReleasableSettlementStatus` — `APPROVED` or `FAILED` only.
3. **Double-claim guard.** Refuses if a `Payout` in `PENDING|SCHEDULED|PAID` covers this event or
   the organization. Checked **before** the claim, so a refusal leaves state untouched.
4. **Atomic claim.** `updateMany({ where: { id, status: { in: ['APPROVED','FAILED'] } } })` →
   `TRANSFER_PROCESSING`. `count !== 1` → another worker won; return.
5. **Provider pre-checks.** Route disabled, or no connected account → released back to a blocked
   state.
6. **Amount.** `computeSettlementPayable({ priorTransferredMinor: settlement.transferredMinor, ... })`.
7. **Zero payable.** → `TRANSFERRED`, `payableMinor: 0`, `releasedAt`. Nothing moved, so
   `releasedMinor` is correctly untouched.
8. **The provider call.** `adapter.createTransfer(...)`, deliberately **outside any transaction** —
   a DB transaction and an HTTP call cannot be made atomic.
9. **Persist, in one transaction.** `status`, `providerTransferId`, `reserveMinor`, `payableMinor`,
   `transferredMinor: prior + payable`, `releasedAt`, `failureMessage: null`, plus the organizer
   notification.

   **`releasedMinor` is absent from this update. That is the whole defect.**

10. **Failure.** `catch` → `FAILED` + `failureMessage` + audit + admin notification + throw.
    Neither money field moves. Correct.

### What provider acceptance means here

`createTransfer` resolving with a `transferId`. There is no second confirmation step — no webhook is
awaited before the settlement is called `TRANSFERRED`.

### The failure window, and why the design already survives it

Provider succeeds → process crashes before step 9. Money has moved; the database says `FAILED`.

The recovery is the idempotency key:

```
idempotencyKey = settlement_<id>_<transferredMinor>
```

It is keyed on the **prior** `transferredMinor`, which only advances once step 9 commits. So a retry
after a lost write sends the **same key**, the provider dedupes, and local state catches up without
moving money twice. `FAILED` is releasable precisely so this retry is permitted.

**The residual edge:** the key ignores the amount, but `computeSettlementPayable` also depends on
`refundsMinor` and `disputesMinor`. A refund landing between the crash and the retry produces the
same key with a **different amount**. Stripe rejects that; Razorpay's behaviour is unverified and is
not guessed at here. Narrow, real, and out of scope for this change.

## 3. The reversal path

`applyRefund` increments `refundsMinor`, then `reverseIfTransferred`:

1. Write the attempt `REQUESTED` and **commit**, before the provider is called.
2. Call the provider with no transaction open.
3. Record what the answer proves.
4. Move money **only** on `CONFIRMED` evidence — `transferredMinor: { decrement }`, in the same
   transaction that claims the attempt, guarded on it still being `REQUESTED`.

`releasedMinor` is never touched. Consistent with "never decremented".

## 4. The four readers

| Reader                                 | How it reads it                       |
| -------------------------------------- | ------------------------------------- |
| `reverseIfTransferred` (clamp)         | `releasedMinor \|\| transferredMinor` |
| `reconcileTransferEvidence` (evidence) | `releasedMinor \|\| transferredMinor` |
| `provider-finance.producer`            | **raw** — no fallback                 |
| `unified-finance.service`              | selects it                            |

The `|| transferredMinor` fallback is commented as serving rows that predate the ledger. Because
nothing ever writes the field, **the fallback is the only branch any row has ever taken.** That is
why the gap stayed invisible until a reader without a fallback was added.

## 5. The live consequence: money is under-recovered

The fallback is not benign. `reversibleMinor(wanted, released, attempts)` clamps to
`outstanding = released − Σ(confirmed)`. With the fallback, `released` **is** `transferredMinor` —
which confirmed reversals have _already_ decremented. The confirmed total is therefore subtracted
**twice**:

```
release 100,000          -> transferredMinor 100,000, releasedMinor 0
reverse 70,000 CONFIRMED -> transferredMinor  30,000, confirmed 70,000

second reversal of 30,000:
  released    = 0 || 30,000 = 30,000     <- already net of the first reversal
  outstanding = 30,000 - 70,000 = -40,000 -> clamped to 0
  reverseMinor <= 0                       -> SILENT RETURN
```

**The second reversal is never attempted.** `refundsMinor` has already been incremented, so the
ledger says the money came back while it is still with the organizer — and no attempt row records
the refusal. With `releasedMinor` written, `outstanding = 100,000 − 70,000 = 30,000` and the
reversal proceeds correctly.

So this is not only a Unified Finance reporting gap. It silently caps recovery at the first
confirmed reversal per settlement.

## 6. Reachable only after a confirmed reversal

Both production readers hide behind the fallback until then, which is consistent with no observed
incident: real reversals need `RAZORPAY_ROUTE_ENABLED`, which is off everywhere.

## 7. `derivedPosition` — REMOVED

It computed a settlement's position from `releasedMinor` and confirmed reversals, and never had a
production caller. It is deleted, and the reasoning is recorded where it stood.

Wiring a caller would have created drift rather than closed a gap. **Position is already said by
the money**: `releasedMinor` is what went out, `transferredMinor` is what is still out, the
difference is what came back. A stored copy can disagree with its source.

It would also have changed no behaviour — both readers of settlement status
(`SETTLEMENT_CLAIMED_STATUSES`, `RELEASED_STATUSES`) already contain all four statuses, so moving
a row from `TRANSFERRED` to `REVERSED` is invisible to both.

`apps/api/src/finance/settlement-position.spec.ts` asserts every position a settlement can hold,
read off the money: nothing sent, fully transferred, partial recovery, full recovery, several
reversals, a failed reversal, a pending one, transfer uncertainty, an open finding, and a stored
contradiction.

## 8. The semantic decision, from repository evidence

`releasedMinor` means **the cumulative minor-unit amount whose provider transfer the provider
accepted, never decremented.** Four independent pieces of the repository agree:

- the schema comment, and its invariant
- `outstandingTransferredMinor` = `releasedMinor − Σ confirmed` — a bound on claw-back only
  meaningful if it is what went out
- `transfer-evidence.ts`: `cumulativeReversedMinor > releasedMinor` is impossible, and
  `originalTransferredMinor !== releasedMinor` is a disagreement on _the original transfer amount_
- `derivedPosition`: `confirmed >= releasedMinor` means fully reversed

Therefore the write is `releasedMinor: { increment: payable.payableMinor }` **in the same
transaction as step 9** — the transaction that already increments `transferredMinor` by the same
amount. At release both rise by X (invariant holds, zero reversals); after a confirmed reversal of R
only `transferredMinor` falls (`transferredMinor == releasedMinor − R`).

It increments rather than assigns because step 6 computes an _incremental_ payable from
`priorTransferredMinor`, so a settlement can legitimately be released more than once.

Step 7's zero-payable path stays untouched: no money moved.

### Why the fallbacks changed too

The write fixes new rows. Every row already in QA and production has `releasedMinor` at 0, so §5
would stay live for all of them. The fallback can be made exact rather than merely present: by the
invariant, what went out is what is still held plus what has been confirmed back —
`transferredMinor + Σ(confirmed)`, both durable columns, read at the same call site. That is
arithmetic, not a reconstruction from status, so it does not cross the line the original migration
drew.

The two fixes are independently falsifiable: removing the write fails 8 tests, and reverting the
fallback fails exactly the one legacy-row test.

## 9. Not addressed by this change

- The same-key/different-amount edge in §2.
- `derivedPosition` being unwired (§7).
- Existing rows. No backfill: reconstructing a released figure from status is exactly what the
  original migration refused to do, and `MOVEMENT_NOT_RECORDED` already reports those rows as a
  limitation rather than inventing a number.
