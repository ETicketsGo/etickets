# Booking-fee schedule approval (maker-checker)

Status: implemented on `feat/fee-schedule-approval`. Not deployed.

## What changed

Before this change, one administrator with `PLATFORM_CONFIG` (or any super admin) could
draft a booking-fee schedule and publish it alone. A publish changes what every later buyer
pays in that currency.

Now a schedule goes live only after a second person approves it:

```
OPEN --submit (maker)--> PENDING_APPROVAL --approve (checker)--> PUBLISHED
  ^                           |
  +--- reject (checker) ------+
  +--- withdraw (maker) ------+
OPEN --discard (maker)--> DISCARDED
```

| Step                          | Who                   | Capability                                 | Fresh MFA | What it does                                                                                           |
| ----------------------------- | --------------------- | ------------------------------------------ | --------- | ------------------------------------------------------------------------------------------------------ |
| Create / save / discard draft | maker                 | `PLATFORM_CONFIG`                          | no        | Prices nothing. Each saver becomes a contributor.                                                      |
| Submit                        | maker                 | `PLATFORM_CONFIG`                          | no        | Draft must be valid, current and different from live. Freezes it. Notifies approvers (not the makers). |
| Withdraw                      | a maker of that draft | `PLATFORM_CONFIG`                          | no        | Back to OPEN.                                                                                          |
| Reject                        | checker, not a maker  | `FEE_SCHEDULE_APPROVE`                     | no        | Reason required (5+ chars). Back to OPEN. Notifies the submitter.                                      |
| Approve                       | checker, not a maker  | `FEE_SCHEDULE_APPROVE`                     | yes       | Publishes in one transaction. Notifies the submitter.                                                  |
| Emergency rollback            | one person            | `PLATFORM_CONFIG` + `FEE_SCHEDULE_APPROVE` | yes       | Restores an EARLIER published version now. Reason 20+ chars. Notifies all other approvers.             |
| Old publish route             | anybody               | -                                          | -         | Always 409 `FEE_SCHEDULE_APPROVAL_REQUIRED`.                                                           |

### The independence rule

Whoever created, saved or submitted a draft may not approve or reject it. The rule is judged
on identity, never on role, so a super admin who drafted a schedule is still its maker
(`approvalIndependenceFailure` in `apps/api/src/admin/fee-schedules.service.ts`). This is
the same rule the bank-account verification uses (`payout-account-safety.ts`). A refused
attempt is audited as `FEE_SCHEDULE_APPROVAL_REFUSED`.

`FEE_SCHEDULE_APPROVE` is in no preset. A super admin holds it (as every capability).
Grant it person by person.

### What the approver sees

- The live bands and the submitted bands, and a fee preview table for sample orders
  (old fee vs new fee, from the checkout's own engine).
- **Financial impact**: the currency's confirmed orders of the last 30 days (up to 5,000),
  re-priced under the live schedule and under the draft: total booking fees before and after,
  how many orders pay more or less, and the largest single increase. It is an estimate: every
  order is priced at the home market, so region-scoped bands and event/organizer fee
  policies are not reflected. The console says so next to the figure.
- Who worked on the draft, the submitter's note, and whether the viewer may decide.
- **Effective date**: approval publishes immediately. There is no scheduled activation (see
  "Not done" below).
- The decision history of the draft, and every published version with its submitter,
  approver, approval note and any emergency flag.

### Immutable history

- `FeeScheduleDecision` rows (SUBMITTED, WITHDRAWN, APPROVED, REJECTED, EMERGENCY_ROLLBACK) are
  append-only: a database trigger refuses UPDATE and DELETE.
- A `FeeScheduleDraft` row with status PUBLISHED cannot be updated or deleted (trigger).
- A draft in PENDING_APPROVAL cannot have its bands changed (trigger), so the approver
  approves exactly what was submitted. The approval also re-checks a SHA-256 of the bands.
- Every step also writes an `AuditLog` entry in the same transaction
  (`FEE_SCHEDULE_SUBMITTED`, `_WITHDRAWN`, `_REJECTED`, `_APPROVED`, `_PUBLISHED`,
  `_EMERGENCY_ROLLBACK`, `_APPROVAL_REFUSED`).

### Checkout and existing bookings

- Checkout reads only the live `FeeRule` rows. Those change only inside an approval or an
  emergency rollback. A pending draft prices nothing (tested: the checkout fingerprint does
  not move while a draft is pending or after it is rejected).
- Confirmed bookings keep their fee snapshot (`bookingFeeMinor` and the fee-policy fields on
  `Booking`). Nothing here re-prices a booking.
- A quote taken before an approval carries the old fingerprint; a booking made from it is
  refused and re-quoted (`FEE_SCHEDULE_CHANGED`), as before.

### Emergency rollback

For live fees that are wrong and cannot wait for a normal approval. It can only restore terms
that were already live once (an earlier published version), so it cannot introduce a fee
nobody approved. It is a new version marked `emergency`, with the restored version number and
the reason. Any open or pending draft becomes stale and cannot be approved.

There is deliberately no "switch all fees off" button: with no live band, checkout falls back
to the built-in default tiers (`DEFAULT_FEE_TIERS`), which is a different price, not zero. To
waive fees for one event or organizer, use a WAIVE fee policy.

## Rollout notes (for whoever deploys this)

1. The migration is additive (new enum values, nullable columns, one new table, two triggers).
   It is safe to deploy the API before the admin web: the old admin web's Publish button will
   get a clear 409 telling the user to submit for approval.
2. **Before deploying to an environment, at least two people there must be able to act**: one
   with `PLATFORM_CONFIG`, and one other person with `FEE_SCHEDULE_APPROVE` (or a second super
   admin). With a single administrator, no fee schedule change can go live after this deploy
   except by emergency rollback. This is a staffing decision for the owner.
3. An OPEN draft that exists at deploy time stays OPEN and is submitted normally. Drafts that
   were published before this change show "published by ... (before approvals)" in history.

## Organizer and event fee overrides (platform fee policies): maker-checker

`PlatformFeePolicy` (admin console: Platform fee policies) overrides the schedule for one
event or one organizer. Organizers cannot create one; they only choose who pays the fee
(`Event.feeMode`). Since `feat/fee-override-approval` (AR-10) every change to what a policy
makes buyers pay needs two people.

### Correction to the first review

The first version of this review said a FIXED, PERCENT or per-ticket policy could charge buyers
MORE than the schedule. **That was wrong.** Every pricing path (`PricingService.quote`,
`AdvertisedPriceService`, and the admin preview) goes through `calculateFeesWithPolicy`, which
keeps the schedule's fee whenever the policy's would be higher (`pricing/fee-policy.ts`). So an
override can only lower or keep a buyer's booking fee. Buyers' fees go UP in two ways:

- **switching a live policy off** (sales return to the schedule), and
- **raising the schedule** above a policy, which then starts to act as a ceiling.

The second is the schedule's own maker-checker. The first is now approved like a creation.

### The rules

| Step                                    | Who                                                                                                                                                                     | Prices sales?            |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| Create (PENDING_APPROVAL)               | `PLATFORM_CONFIG`, fresh MFA                                                                                                                                            | No                       |
| Approve (-> ACTIVE)                     | `FEE_SCHEDULE_APPROVE`, fresh MFA, **not the creator** (super admin too)                                                                                                | Yes, from its start time |
| Reject (-> REJECTED, final)             | `FEE_SCHEDULE_APPROVE`, not the creator, a reason of 5+ characters                                                                                                      | Never did                |
| Withdraw (-> WITHDRAWN, final)          | The creator only                                                                                                                                                        | Never did                |
| Ask to switch off (request)             | `PLATFORM_CONFIG`, fresh MFA                                                                                                                                            | Yes, until approved      |
| Approve switch-off (-> INACTIVE, final) | `FEE_SCHEDULE_APPROVE`, fresh MFA, **not the requester**                                                                                                                | No                       |
| Reject / withdraw the switch-off        | Approver (not the requester) / the requester only                                                                                                                       | Yes, unchanged           |
| Emergency switch-off (-> INACTIVE)      | One person holding `PLATFORM_CONFIG` AND `FEE_SCHEDULE_APPROVE`, fresh MFA, reason of 20+ characters; recorded as an emergency, every other approver notified to review | No                       |

- **Pending prices nothing**, at three independent layers: the resolver only reads `ACTIVE`
  rows, `feePolicyApplies` refuses any other status, and the hold-time reserve SQL matches
  `status = 'ACTIVE'` only.
- **Concurrency.** Approve takes the same per-target advisory lock as create, re-checks the
  state, the version the approver read, the independence rule, the window, and that no other
  approved policy overlaps now. Every decision is a conditional update on `(id, version,
state)`, so of two simultaneous decisions exactly one commits; the other gets 409.
- **Start time.** A start that passed while the policy waited moves to the approval time.
  Nothing is re-priced. A policy whose end passed while it waited cannot be approved.
- **Overlap.** A pending policy counts when a new one is created for the same target and time,
  so two overlapping policies cannot both be approved later.
- **Database guard** (`platform_fee_policy_guard`): refuses an INSERT that is not
  PENDING_APPROVAL unless it names an approver other than its creator; any change to the terms,
  target, window end, order limit, creator or reason; a start that moves after approval; a
  changed approver; leaving a final state; ACTIVE from PENDING_APPROVAL without an independent
  approver; and INACTIVE that did not come through an approved request (approver != requester)
  or the emergency flag. `PlatformFeePolicyEvent` refuses UPDATE (DELETE stays possible for
  test harnesses, as with `AuditLog`, AR-12).
- **Impact.** `GET /admin/platform-fee-policies/:id/impact?days=30` re-prices the target's
  confirmed orders of the last N days (up to 5,000) on today's schedule, with and without the
  pending decision, per currency, with the direction (INCREASE / DECREASE / MIXED / NONE).
- **Audit.** `PLATFORM_FEE_POLICY_{CREATED, APPROVED, REJECTED, WITHDRAWN,
DEACTIVATION_REQUESTED, DEACTIVATION_REJECTED, DEACTIVATION_WITHDRAWN, DEACTIVATED,
EMERGENCY_DEACTIVATED, APPROVAL_REFUSED}`, each written in the same transaction as the change
  (the refusal is written on its own, before the 403).
- **Notifications** reuse the fee-schedule types: `FEE_SCHEDULE_AWAITING_APPROVAL` with kind
  `POLICY_SUBMITTED`, `POLICY_DEACTIVATION` or `POLICY_EMERGENCY_DEACTIVATED` to every
  `FEE_SCHEDULE_APPROVE` holder except the actor and the creator; `FEE_SCHEDULE_DECIDED` with
  subject `POLICY` or `POLICY_DEACTIVATION` back to the maker.

### Rollout notes

1. Additive migration (`20261106120000_fee_policy_approval`): three enum values, nullable
   columns, one boolean with a default, two triggers. Existing ACTIVE policies are untouched
   and keep pricing; they show no approver ("before approvals").
2. **Rolling back the API to the previous release** after this migration: the old code inserts
   policies as ACTIVE with no approver, which the guard refuses, so creating a policy fails
   closed (500, nothing is priced). The old deactivate writes INACTIVE without a request and is
   refused the same way. Pricing, holds, payments and refunds are unaffected. Fix forward, or
   drop the two triggers by hand if a rollback must last.
3. The same staffing rule as schedules: each environment needs one `PLATFORM_CONFIG` holder and
   a different person with `FEE_SCHEDULE_APPROVE` (or a second super admin), or no override can
   go live and none can be switched off except by the emergency path.

## Not done (extension points)

- **Scheduled effective date.** Approval publishes immediately. A future `effectiveFrom` needs
  a worker step that re-checks the fingerprint and validation at activation time. The
  `effective` field in the draft response is where that would surface.
- **Append-only `AuditLog` at the database level.** The audit log is append-only by
  convention only. The trigger pattern used here could be applied to it, but test harnesses
  delete audit rows today, so that is its own change.

## Tests

- `apps/api/src/admin/fee-schedules.service.spec.ts`: every publish in the existing tests now
  goes through submit by the maker and approval by another person; new tests for the frozen
  pending state, the independence rule (submitter, other contributors, super admin), reject,
  withdraw, no-change submissions, the retired publish, a stale pending draft, and emergency
  rollback (restores, refuses the live / later / unknown versions, needs a reason).
- `apps/api/src/admin/fee-schedule-approval.integration-postgres.spec.ts`: real HTTP, guards,
  database and triggers. Falsified: with the independence rule disabled, 3 tests fail.
- `apps/api/src/admin/step-up-routes.spec.ts`: approve and emergency rollback need a fresh
  second factor; draft, submit, withdraw and reject do not.
