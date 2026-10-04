# The payout lifecycle

How money reaches an organizer, what is persisted at each step, and what happens when something
goes wrong. Canonical as of the Finance/payout freeze; supersedes nothing but gathers what was
scattered across `PROVIDER-EXECUTION-AND-RECONCILIATION.md`,
`SETTLEMENT-RELEASE-LIFECYCLE.md` and `PROVIDER-EXECUTION-READINESS.md`.

> **Automatic organizer payouts are OFF.** `PAYOUT_EXECUTION_ENABLED` defaults false and nothing
> schedules a release. Ticket sales are entirely independent of it — see §6.

---

## 1. The path

```
booking + payment
  -> organizer entitlement accrues on the Settlement
  -> settlement becomes ELIGIBLE, then APPROVED by a person
  -> release() is called by an admin        [no automation exists]
  -> payout execution switch                [OFF by default]
  -> durable transfer attempt, committed BEFORE the provider is called
  -> provider answers: ACCEPTED | REFUSED | INDETERMINATE
  -> movement recorded in one transaction with the organizer notice
  -> refunds claw back through reversal attempts
  -> uncertainty becomes a reconciliation finding
  -> an operator sees it, and dispositions it
```

## 2. Every transition

| Transition          | Who starts it                  | Eligible when               | Persisted before any external call        | Provider capability needed |
| ------------------- | ------------------------------ | --------------------------- | ----------------------------------------- | -------------------------- |
| entitlement accrues | payment webhooks               | a paid booking exists       | the `Settlement` row                      | none                       |
| ELIGIBLE            | event completion + hold period | event finished, hold passed | status                                    | none                       |
| APPROVED            | a person                       | finance review              | status + approver                         | none                       |
| **release**         | **a person, via admin API**    | APPROVED or FAILED          | **attempt row, committed**                | `createTransfer`           |
| movement recorded   | release, on ACCEPTED           | provider accepted           | money + attempt + notice, one transaction | none                       |
| reversal            | refund/dispute webhooks        | money is still out          | attempt row, committed                    | `reverseTransfer`          |
| reconciliation      | worker or operator recheck     | attempt unresolved          | finding row                               | `getTransferState`         |
| disposition         | an authorized operator         | an OPEN finding             | finding row                               | none                       |

**No row in that table is automated end-to-end.** The only thing that moves money is a person
pressing release, and only when the switch is on.

## 3. What happens when it goes wrong

| Situation                                    | What is recorded                         | What happens next                                                                       |
| -------------------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------- |
| provider **refuses** (authoritative)         | attempt `FAILED` + reason                | releasable again; the question is settled                                               |
| provider **times out** / unreadable          | attempt `UNKNOWN` + cause                | **never retried blindly**; a replay needs a deduplicating provider, otherwise `BLOCKED` |
| **crash during the call**                    | the `REQUESTED` attempt, committed first | visible in the operator queue                                                           |
| **crash after acceptance, before our write** | attempt `UNKNOWN`                        | retry under the **same** operation identity; the provider deduplicates                  |
| **amount changed** under the same identity   | nothing sent                             | `BLOCKED` — a changed amount is a different operation                                   |
| duplicate webhook                            | nothing new                              | claim is on the row's state, so it is a no-op                                           |
| provider later **contradicts** us            | an OPEN finding                          | **no silent repair**, ever                                                              |
| nothing can establish it                     | `CANNOT_BE_ASKED` finding                | an operator dispositions it                                                             |

## 4. Operation identity

One operation is **one settlement at one prior transferred amount**:

```
settlement_<settlementId>_<priorTransferredMinor>
```

Stable across replays on purpose — that is what makes recovery possible. Attempts sharing the key
are attempts at the same external movement, which is also what makes a changed amount detectable.

**It only reaches the provider through an adapter that sends it.** Stripe does; Razorpay does not,
and declares `supportsIdempotentTransfer: false` for that reason. The replay gate reads that
declaration.

## 5. Recovery, by capability

| Provider can…                | Recovery                                                 |
| ---------------------------- | -------------------------------------------------------- |
| prove idempotent replay      | replay the same operation; the provider deduplicates     |
| be asked for transfer status | **observe first**, then catch up without resending       |
| both                         | observe first — a question cannot move money by mistake  |
| **neither**                  | **BLOCK.** A person establishes it. Never resend blindly |

Today every real adapter is in the last row for status query, and only Stripe is in the first.

## 6. The switches, and what they do not touch

| Switch                                  | Default   | Stops                                                   |
| --------------------------------------- | --------- | ------------------------------------------------------- |
| `PAYOUT_EXECUTION_ENABLED`              | **false** | **all** outbound organizer transfers, every provider    |
| `RAZORPAY_ROUTE_ENABLED`                | false     | Razorpay Route specifically                             |
| `TRANSFER_OBSERVATION_ENABLED`          | **false** | the observation worker (which cannot move money anyway) |
| `SETTLEMENT_REVERSAL_RECONCILE_ENABLED` | false     | the reversal sweeper                                    |

**None of them touches ticket sales.** With payouts off: customers buy normally, entitlement
accrues, Finance shows what is owed and what is eligible, and the only thing refused is the
outbound transfer — with a message saying exactly that. A settlement refused while the switch is
off stays `APPROVED`; it is not marked `BLOCKED`, because "payouts are off" is a fact about the
platform and not a problem with that settlement.

This is the controlled-launch posture: **ticket sales ON, automatic payouts OFF.**

## 7. Manual launch mode

For a pilot where organizers are paid outside the platform, the system distinguishes four things
and will not confuse them:

| Concept                           | Where it lives                                     |
| --------------------------------- | -------------------------------------------------- |
| what is **owed**                  | `Settlement.grossSalesMinor`, shown in Finance     |
| an internally recorded **payout** | the `Payout` ledger                                |
| **provider transfer evidence**    | `SettlementTransferAttempt` + `releasedMinor`      |
| settled **outside the platform**  | a finding dispositioned `SETTLED_OUTSIDE_PLATFORM` |

**Nothing fabricates provider movement because somebody paid an organizer by bank transfer.**
Recording an external settlement as if it were a provider transfer would corrupt the one record
that reconciliation depends on.

> **Open product decision.** There is no first-class "record an external settlement" operation.
> Today the nearest honest thing is a dispositioned finding, which closes an exception but does
> not mark the entitlement as paid. Whether the pilot needs more than that is a business
> question, recorded rather than guessed at.

## 8. Reconciliation and disposition

Detection and repair are separate privileges.

Reconciliation may **observe, classify and record**. It is constructed with Prisma and a reader
that has one method, so it has no means to send, refund or reverse anything.

An authorized operator may **disposition** an exception — `PROVIDER_CONFIRMED_SENT`,
`PROVIDER_CONFIRMED_NOT_SENT`, `SETTLED_OUTSIDE_PLATFORM`, `CANNOT_ESTABLISH` — recording actor,
time, a mandatory reason and, where the disposition claims a provider fact, the reference they
saw. **Disposition moves no money either.**

A consequence worth stating plainly: **closing an exception does not clear an `UNKNOWN` transfer
from Finance.** The investigation ends; the money question does not. Catching the ledger up is a
separate financial operation that does not exist yet, deliberately, because nobody has decided who
may perform it.

## 9. What is NOT automated, and why that is the point

- no scheduled release
- no transfer sweeper that could resend
- no automatic ledger correction from reconciliation
- no automatic ledger correction from a disposition

Enabling payouts later is `PAYOUT_EXECUTION_ENABLED=true` plus provider capability verification —
not a design exercise.
