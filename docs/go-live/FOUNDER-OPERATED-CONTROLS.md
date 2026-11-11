# Founder-operated administration: separation-of-duties review and proposed controls

**Status: approved by the owner 2026-11-11 and IMPLEMENTED (see section 4). Off by default;
switched on only in QA for certification. Not in UAT or PROD.**
Owner decision (2026-11-11): ETicketsGo has no operating staff team. The super admin is the
platform operator. Launch must not depend on hiring or extra accounts.

## 1. Authorization is already complete

The super admin holds every admin capability (`permissionsFor`: `SUPER_ADMIN` -> all
`AdminPermission`s, `packages/shared-types/src/admin-permissions.ts`). No authorization
check (missing duty) ever refuses the super admin. Every refusal below is an **identity**
rule (separation of duties), applied to the super admin on purpose.

The super admin can already do these alone, with no identity rule in the way:

| Workflow                                                              | Duty                           | Note                                                                                                 |
| --------------------------------------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Approve or reject organizer applications                              | ORGANIZER_REVIEW               | no identity rule                                                                                     |
| Approve or reject events                                              | EVENT_REVIEW                   | no identity rule                                                                                     |
| Approve refunds                                                       | REFUND_APPROVE                 | no identity rule                                                                                     |
| Verify or reject an organizer's bank account                          | BANK_VERIFY                    | only when the organizer entered the details and the super admin is not a member of that organization |
| Approve a legal-identity change                                       | ORGANIZER_REVIEW + fresh MFA   | only when the organizer made the change and the super admin is not a member                          |
| Settlement terms, hold days, block a settlement, mark a payout failed | PAYOUT_MANAGE / PAYOUT_EXECUTE | no identity rule                                                                                     |
| Mark a payout paid                                                    | PAYOUT_EXECUTE + fresh MFA     | only when **someone else** verified the account (R1)                                                 |

## 2. Separation-of-duties rules that stop one person

| Id  | Rule (code)                                                                                                                                  | Refusal today                                                                                     | Effect when the founder operates alone                                                                                                    |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | Whoever verified the account version may not mark a payout into it paid (`verifierMayNotPay`, `payouts.service.ts` markPaid)                 | 403 `FORBIDDEN`, `details.hold: VERIFIER_CANNOT_PAY`                                              | **Blocks every manual payout.** The founder must verify the account (R2 allows it) and then cannot pay                                    |
| R2  | A bank account is checked by staff who neither saved it nor belong to the organization (`independenceFailure`, `payout-accounts.service.ts`) | 403 `FORBIDDEN`, no reason code in the response (audit has `SAME_PERSON` / `ORGANIZATION_MEMBER`) | Fine while organizers enter their own details. Blocks the founder entering details for an organizer, and the founder's own organization   |
| R3  | A legal-identity change is reviewed by someone who did not make it and is not a member (`identityReviewerFailure`)                           | 403 `FORBIDDEN`, no reason code in the response                                                   | Fine while organizers edit their own identity. Blocks identity the founder records for an organizer, and the founder's own organization   |
| R4  | Approving a changed legal name or form sends verified accounts back for checking, recorded as saved by the reviewer (`reviewLegalIdentity`)  | then R2 `SAME_PERSON`                                                                             | The founder approves the identity, then cannot verify the re-queued account. Workaround today: the organizer saves the bank details again |
| R5  | Settlement release: releaser is not the approver (`settlement.service.ts`)                                                                   | 403                                                                                               | None while automatic transfers stay off                                                                                                   |
| R6  | Booking-fee schedule: approver is not any maker (`fee-schedules.service.ts`)                                                                 | 403 `details.reason: NOT_INDEPENDENT`                                                             | The founder cannot change booking fees alone. Live fees are already set                                                                   |
| R7  | Platform fee policy: approver is not the creator; deactivation approver is not the requester                                                 | 403                                                                                               | Same as R6                                                                                                                                |
| R8  | Payment configuration promotion to PRODUCTION needs two approvers, never the requester (`promotion.service.ts`)                              | 409                                                                                               | Founder cannot promote payment configuration alone. PROD payment configuration is already in place                                        |

**Authorization vs separation of duties today:** both come back as HTTP 403 with code
`FORBIDDEN`. Only R1 and R6 put a machine-readable reason in the response.

**The existing second PROD admin account** (BANK_VERIFY + PAYOUT_MANAGE) must not be used by the
founder to satisfy R1. Doing so would bypass the rule without anyone seeing it. If the founder
holds that login, suspend it. If another person holds it, record who.

## 3. Proposed founder-operated controls (owner approval needed before any code)

Scope: **R1 only**, the single rule that stops the core payout lifecycle. R2-R4 are handled by
process: organizers enter their own bank and identity details, and the founder never edits
them on an organizer's behalf. R5-R8 stay strict; there is no launch need.

Name: **sole-operator payout confirmation**.

1. **Switch.** `SOLE_OPERATOR_MODE` variable, default off, enabled per environment (QA first).
   It applies to `SUPER_ADMIN` only, and never to an organization the actor belongs to.
2. **The organizer is the second pair of eyes.** When the founder verifies a bank account in
   this mode, each organization owner is emailed: the bank, the holder name and the last four
   digits, with a link that says "this is not our account". That link puts the account back to
   pending, holds payouts and is audited.
3. **Cooling-off.** The verifier may mark a payout paid only when the account version was
   verified at least **48 hours** earlier and nobody disputed it. Verification and payment can
   never happen in one sitting.
4. **Evidence when verifying.** A required verification method (penny drop, bank letter or
   cancelled cheque), an evidence reference, and the last four digits typed again. This is in
   addition to the automatic holder-name ownership match.
5. **Evidence when paying.** Fresh MFA step-up, the bank reference (UTR/ACH), the amount typed
   again and checked against the payout, and a stored attestation ("I am the only operator. I
   checked the transfer on the bank statement").
6. **Everything else stays.** Ownership match, approved identity, duplicate-payment claim,
   provider-transfer claim, holds and amounts all stay exactly as they are. This only replaces
   "a different person" with "the organizer, 48 hours, and evidence" for R1.
7. **Visible and audited.** `PAYOUT_PAID` metadata carries `soleOperator: true`,
   `rule: VERIFIER_CANNOT_PAY`, `verifiedAt` and the evidence reference. An ops alert email
   goes out on each use, plus a weekly digest. The admin Payouts row shows "Sole operator".
8. **Distinct refusals.** Every separation-of-duties refusal (R1-R8) returns code
   `SEPARATION_OF_DUTIES` with `details.rule`, separate from authorization's
   `FORBIDDEN`/missing duty. The console then says which rule applied and what would satisfy
   it.
9. **Reversible.** Turning the switch off restores strict mode at once. Turn it off when a
   second operator joins.

Not proposed: a role that skips R1 silently, shared or fake accounts, weakening R2/R3 for the
founder's own organization (DeepTrics stays independent-review only; non-blocking).

Delivery after approval: one PR (API rule + organizer email + admin evidence fields + error
code), QA certification of verify -> 48 h -> pay and the dispute path, then a pinned PROD
release.

## 4. What was built

Switch: `SOLE_OPERATOR_MODE=on` on the **api** service. Unset or anything else is off.

| Control                | Where                                                                                                                                                                                                                                        |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Super admin only       | `soleOperatorUnmet` (`payout-account-safety.ts`): `NOT_SUPER_ADMIN`                                                                                                                                                                          |
| Never for own org      | membership of any status, read in the payment transaction: `ORGANIZATION_MEMBER`                                                                                                                                                             |
| Organizer confirmation | `POST /payouts/accounts/:id/confirm` (owner, organizer-only): full number and bank code typed again, must match; bound to the version. `NOT_CONFIRMED_BY_ORGANIZER`                                                                          |
| Change restarts        | a save clears verification, evidence, confirmation and any dispute (new version)                                                                                                                                                             |
| Evidence               | `POST /admin/payouts/accounts/:id/verified` takes `method` (PENNY_DROP, BANK_LETTER, CANCELLED_CHEQUE, BANK_STATEMENT), `evidenceReference`, `accountLast4` (must match). `NO_VERIFICATION_EVIDENCE`                                         |
| 48 hours               | `SOLE_OPERATOR_WAIT_MS`, from `verifiedAt`. `WAITING_PERIOD`                                                                                                                                                                                 |
| Dispute                | `POST /payouts/accounts/:id/dispute` (owner). Holds every payout into the account for every payer (`DESTINATION_DISPUTED`), withdraws the confirmation, ops alert. Ends only by a new save                                                   |
| Fresh MFA              | `@RequiresRecentMfa` on the pay route (unchanged)                                                                                                                                                                                            |
| Reference, amount      | `reference` required (`BANK_REFERENCE_REQUIRED`), `amountConfirmedMinor` must equal the payout (`AMOUNT_NOT_CONFIRMED`; a wrong amount is refused on every path, 400 `AMOUNT_MISMATCH`)                                                      |
| Attestation            | `soleOperatorAttestation: true` (`ATTESTATION_REQUIRED`)                                                                                                                                                                                     |
| Unchanged protections  | ownership match, approved identity, provider-transfer claim and the duplicate-payment claim run before the exception                                                                                                                         |
| Audit and alert        | `PAYOUT_PAID` with `soleOperator: true`, plus `PAYOUT_PAID_SOLE_OPERATOR` with the evidence; ops alert `SOLE_OPERATOR_PAYOUT` per use; `Payout.soleOperator` shown as "Sole operator"                                                        |
| Distinct refusals      | separation of duties returns `SEPARATION_OF_DUTIES` with `details.rule` (R1 `VERIFIER_CANNOT_PAY`, R2 `BANK_VERIFIER_INDEPENDENT`, R3 `IDENTITY_REVIEWER_INDEPENDENT`, R5, R6, R7); a missing duty stays `FORBIDDEN` with `details.required` |

R2 and R3 are unchanged: the founder still cannot verify bank details they entered or that
belong to their own organization, and cannot approve their own identity change.

Not built: a weekly digest email (the audit log and the ops alert per use cover it for now).
