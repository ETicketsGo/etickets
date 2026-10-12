# Finance separation of duties

Status: PROPOSED. Needs the owner's approval before merge (it changes who may verify bank accounts and who may
mark payouts paid). Base: main 3ef1b51. Date: 2026-10-12. Nothing in this change grants a permission to anyone on
any environment. No payout amount, allocation, settlement or provider logic changed.

This closes gap G1 in `docs/pilot/OPERATING-PROCEDURES.md`: one capability (`PAYOUT_MANAGE`) covered verify,
reveal, pay and settlements, and a super admin could do all of it alone.

## The rule

A person who verified a bank account must never record a payout into that account as paid. The server enforces
it, not a procedure. It is judged on the person's identity, not on a role or capability, so it holds for a super
admin and for someone who was wrongly given both duties.

## Capabilities after this change

| Capability       | What it allows                                                                                                                          | New           |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `PAYOUT_MANAGE`  | Open Payouts and Settlements, see masked accounts and history, show one account number (audited), edit payout terms, block a settlement | no (narrowed) |
| `BANK_VERIFY`    | Verify or turn down an organizer bank account. Needs `PAYOUT_MANAGE` too                                                                | yes           |
| `PAYOUT_EXECUTE` | Mark a payout paid or failed, approve and release a settlement. Needs `PAYOUT_MANAGE` too                                               | yes           |

A write route needs all of its listed capabilities. Verify and reject need `PAYOUT_MANAGE` and `BANK_VERIFY`. Pay,
fail, settlement approve and settlement release need `PAYOUT_MANAGE` and `PAYOUT_EXECUTE`.

## Permission matrix (role x capability)

Presets are granted to nobody. A preset applies only when a person with `ADMIN_MANAGE` assigns it on Staff & duties.
"Y" means the preset holds it. Super admin holds everything by role, so it is shown last.

| Capability                                             | Finance A (`FINANCE_VERIFIER`) | Finance B (`FINANCE_PAYER`) | Reviewer (`FINANCE_REVIEWER`) | On-call (`OPS_ONCALL`) | Existing `FINANCE` | Super admin |
| ------------------------------------------------------ | :----------------------------: | :-------------------------: | :---------------------------: | :--------------------: | :----------------: | :---------: |
| `BOOKING_READ` (incl. audit log)                       |               Y                |              Y              |               Y               |                        |         Y          |      Y      |
| `FINANCE_READ`                                         |               Y                |              Y              |               Y               |                        |         Y          |      Y      |
| `PAYOUT_MANAGE`                                        |               Y                |              Y              |                               |                        |         Y          |      Y      |
| `BANK_VERIFY`                                          |               Y                |                             |                               |                        |                    |      Y      |
| `PAYOUT_EXECUTE`                                       |                                |              Y              |                               |                        |                    |      Y      |
| `OPS_READ`                                             |                                |                             |                               |           Y            |                    |      Y      |
| `OPS_EXECUTE`                                          |                                |                             |                               |           Y            |                    |      Y      |
| `REFUND_APPROVE`, `FINANCE_APPROVE`, `FINANCE_RESOLVE` |                                |                             |                               |                        |         Y          |      Y      |

What each person can do, by action:

| Action                                    | Finance A |                Finance B                 | Reviewer | On-call | Existing `FINANCE` |               Super admin                |
| ----------------------------------------- | :-------: | :--------------------------------------: | :------: | :-----: | :----------------: | :--------------------------------------: |
| See masked bank accounts and payouts      |    yes    |                   yes                    |    no    |   no    |        yes         |                   yes                    |
| Show a full account number (audited)      |    yes    |                   yes                    |    no    |   no    |        yes         |                   yes                    |
| Verify or turn down an account            |    yes    |                    no                    |    no    |   no    |  **no (was yes)**  |                   yes                    |
| Mark a payout paid or failed              |    no     | yes, never into an account they verified |    no    |   no    |  **no (was yes)**  | yes, never into an account they verified |
| Approve or release a settlement           |    no     |                   yes                    |    no    |   no    |  **no (was yes)**  |                   yes                    |
| Block a settlement, edit payout terms     |    yes    |                   yes                    |    no    |   no    |        yes         |                   yes                    |
| Read finance reports and the audit log    |    yes    |                   yes                    |   yes    |   no    |        yes         |                   yes                    |
| Retry failed jobs, outbox, inventory sync |    no     |                    no                    |    no    |   yes   |         no         |                   yes                    |

Notes on the four roles:

- Reviewer reads finance and the audit log. It has no `PAYOUT_MANAGE`, so it cannot see bank accounts and cannot
  move money. It does not get `PLATFORM_CONFIG_READ` because the owner approved that for `FINANCE` only on
  2026-10-10. Reconciliation pages need `PAYMENT_ADMIN` today, which also resolves findings, so the Reviewer
  cannot open them. See "Residual risk".
- On-call (`OPS_ONCALL`) has the same capabilities as the existing `OPERATIONS` preset: queues, outbox and
  inventory sync. No money, no bank data. Turning maintenance mode on needs `PLATFORM_CONFIG`, and the payment
  outage switch needs `PAYMENT_ADMIN`. Both are broad, were not added to the preset, and are the owner's decision.
- The reveal action stays on `PAYOUT_MANAGE` so Finance A and Finance B can both read a number. It is audited.

## The workflow

1. The organizer owner saves bank details. Staff cannot save them.
2. Finance A checks the details and presses "Mark checked" (`POST /admin/payouts/accounts/:id/verified`). The
   saver and any member of the organization are refused (already in main, #323). The verifier's user id is stored
   on the account row (`verifiedByUserId`) and the decision on the version row.
3. Finance B opens Payouts and presses "Mark paid" (`POST /admin/payouts/:id/pay`). The server, in one
   transaction with a `FOR SHARE` lock on the account row:
   1. refuses if the account is missing, pending or turned down (#324, unchanged);
   2. **refuses with 403 `VERIFIER_CANNOT_PAY` if the caller is the verifier of the current account version**;
   3. otherwise marks the payout PAID.
4. A refusal writes an audit row `PAYOUT_PAID` with `outcome: REFUSED` and `reasonCode: VERIFIER_CANNOT_PAY` (or the
   existing `DESTINATION_*` code). The payout stays as it was. The message is: "You verified this bank account, so
   someone else must mark this payout paid."
5. If the owner changes the details, the account returns to pending and the verifier is cleared. A new
   verification by another person frees the first verifier for the new version only.

A payout that sends nothing to the organizer (net zero or a clawback) has no destination, so the rule does not apply.

### Every path that can mark a payout paid

- `POST /admin/payouts/:id/pay` is the only code that sets a payout to PAID (`PayoutsService.markPaid`). A unit test
  fails if any other file in `apps/api/src` writes `status: PayoutStatus.PAID`.
- The scheduled payout run (`PayoutRunService`) only creates payouts. It never marks one paid.
- Provider execution (Stripe Connect or Razorpay Route transfers) goes through settlements, not through
  `OrganizerPayoutAccount`. It is a separate system (bank accounts versus provider accounts), stays off by the
  provider transfer release gate, and now also needs `PAYOUT_EXECUTE`. The verifier rule has no meaning there
  because nobody verifies a provider account in this table. If a future path marks bank payouts paid
  automatically, it must call `verifierMayNotPay` or go through `markPaid`. The test above forces that decision.

## Existing grants: what changes and the migration

Nothing is migrated and nothing is granted. There is no Prisma migration in this change.

| Who                                                                | Before                                    | After                                                                       |
| ------------------------------------------------------------------ | ----------------------------------------- | --------------------------------------------------------------------------- |
| Super admin                                                        | everything alone                          | everything, but never pays into an account they verified                    |
| Account assigned the `FINANCE` preset or any `PAYOUT_MANAGE` grant | verify, pay, fail, release, reveal, terms | reads, reveal, terms, block. **Loses verify, pay, fail, approve, release.** |
| Anyone else                                                        | unchanged                                 | unchanged                                                                   |

This is a narrowing only: nobody gains anything. The `FINANCE` preset is unchanged (no widening, and the
owner-approved bundle test still passes), so a new person given `FINANCE` cannot verify or pay until they are also
given `BANK_VERIFY` or `PAYOUT_EXECUTE`.

Before merge the owner must list who holds `PAYOUT_MANAGE` on each environment (read only). Do not run this against
production without the owner:

```sql
SELECT u.email, array_agg(g.permission ORDER BY g.permission) AS duties
FROM "AdminGrant" g JOIN "User" u ON u.id = g."userId"
WHERE g."userId" IN (SELECT "userId" FROM "AdminGrant" WHERE permission = 'PAYOUT_MANAGE')
GROUP BY u.email;
```

Everyone listed (other than super admins) will lose verify and pay. The owner decides who gets which new duty.

## Role assignment plan (the owner names the people; nothing is granted here)

| Seat               | Preset             | Who the owner must name | Rule                                                                                 |
| ------------------ | ------------------ | ----------------------- | ------------------------------------------------------------------------------------ |
| Finance A          | `FINANCE_VERIFIER` | _owner to name_         | Not a member of any organizer being paid. Must not be Finance B.                     |
| Finance B          | `FINANCE_PAYER`    | _owner to name_         | A different person from Finance A. Must not be a member of the organizer being paid. |
| Reviewer           | `FINANCE_REVIEWER` | _owner to name_         | Independent of A and B. No money, no bank data.                                      |
| On-call operations | `OPS_ONCALL`       | _owner to name_         | Incident handling only.                                                              |
| Super admin        | (by role)          | the owner               | Keep to one or two people. Avoid using it for daily payout work.                     |

Assign on Staff & duties, one preset per person. Do not give one person both `FINANCE_VERIFIER` and
`FINANCE_PAYER`. The server would still refuse them as payer for an account they verified, but they could pay
accounts that someone else verified, which defeats the second pair of eyes for those.

## How to verify after the owner grants the duties on QA

Use QA only, with named test accounts, and a K-TEST organizer and payout.

1. Sign in as Finance A. Payouts > Bank accounts: "Mark checked" is shown. On Payouts, rows show "You can see this
   but cannot mark payouts paid. That needs the Payout execute duty."
2. Mark an organizer account checked. The Checked column reads "Verified by <your email>. You verified this
   account, so someone else must mark payouts to it as paid."
3. Sign in as Finance B. "Mark checked" is replaced by a note. "Mark paid" is shown. Mark a test payout paid. It
   succeeds.
4. As a person holding both duties (or a super admin) who verified another test account, try "Mark paid". The toast
   reads "You verified this bank account, so someone else must mark this payout paid." The payout stays open.
   Audit log: `PAYOUT_PAID`, outcome `REFUSED`, reason `VERIFIER_CANNOT_PAY`.
5. Sign in as Reviewer and as On-call. Payouts and Bank accounts pages must not appear in the menu, and a direct
   API call to `/admin/payouts/accounts` must return 403.
6. Check `GET /auth/me` `adminPermissions` for each account against the matrix above.

## Tests

- `payout-separation-of-duties.integration-postgres.spec.ts` (real Postgres, real HTTP and guards): A verifies then
  cannot pay; B pays; B cannot verify; a person holding both is refused with the audit row; a super admin who
  verified is refused and another super admin pays; the rule follows the account version; clawbacks exempt;
  reviewer and on-call get 403 on every money and bank route; the shipped `FINANCE` preset keeps reads and loses
  verify and pay.
- `payout-separation-of-duties.spec.ts`: the identity rule, a source scan that only `markPaid` writes PAID, that the
  guard sits after the destination hold and before the claim, and the capability on each handler.
- Existing #323 and #324 specs run unchanged apart from granting their test staff the two new duties.

## Residual risk

- Collusion: Finance A and Finance B can still conspire, or one person can control two accounts. The rule makes
  one person unable to do both steps; it does not make two people honest. The audit log shows both.
- A super admin can grant themselves or a second account any duty, or create a second account. The rule stops one
  identity from doing both steps, not one human with two identities. Keep super admins few and review Staff &
  duties.
- A super admin can still verify an account and then edit data directly in the database. Out of scope here.
- The `FINANCE` preset no longer lets a new hire verify or pay until they are given the new duties. Anyone relying on
  it today loses access when this merges (see the list above).
- Reviewer cannot open reconciliation pages (they need `PAYMENT_ADMIN`, which can also resolve findings). A read-only
  reconciliation capability would be a separate change.
- On-call cannot switch maintenance mode or the payment outage switch without broader capabilities
  (`PLATFORM_CONFIG`, `PAYMENT_ADMIN`). The owner decides whether to give them out or split them.
- Finance A can show a full account number; so can Finance B. Both are audited. Splitting reveal is possible later.
- A person who verified an account earlier and is later the only available payer for a different version is
  allowed; the rule is per version, as in the task.
- The settlement approve/release path for provider accounts has no verifier concept; it only needs the new duty.
