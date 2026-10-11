# Admin permission matrix

Status: current as of branch `feat/authz-read-write-execute` (base `main` 2358921).
Source of truth: `packages/shared-types/src/admin-permissions.ts` (catalogue and presets) and the
`@RequiresAdmin(...)` decorators on each controller. This document describes them. It does not
replace them.

## How access is decided

- A back-office account has the `ADMIN` role plus zero or more **capabilities** (rows in
  `AdminGrant`). `AdminPermissionGuard` reads the grant rows on every request, so a revoked
  capability stops working at once.
- `SUPER_ADMIN` holds every capability **by role** (`permissionsFor`), including any capability added
  later. It cannot be locked out by revoking grants.
- A route's capability is the handler's own `@RequiresAdmin`, or, if it has none, the class's.
  When a route lists several capabilities, the caller needs **all** of them.
- Presets are applied when a duty is assigned. They are not checked on each request: editing a
  preset never changes what an existing account holds.
- **Read and write are separate.** A read capability opens a page and its GET routes. It never
  opens a write. Two tests enforce this (see the last section).

## Capability catalogue

"Presets" lists the ready-made bundles that grant the capability, as approved by the owner on
2026-10-10. Seeded and bootstrapped
accounts are `SUPER_ADMIN` and hold everything by role, so this column does not list them.

| Capability                    | What it allows                                                                                                                                                               | Presets                         | Added by the approved preset change (2026-10-10) |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------ |
| `BOOKING_READ`                | See bookings, payments, movies, the dashboard, the audit log, the support inbox, and the user directory                                                                      | SUPPORT, REFUND_DESK, FINANCE   | -                                                |
| `ORGANIZER_READ`              | See organizations, their events and their status                                                                                                                             | SUPPORT, REFUND_DESK, MODERATOR | -                                                |
| `FINANCE_READ`                | See revenue reports, analytics, compensations (and their dry run), discrepancies (list, CSV, aging), disputes, and notification costs                                        | FINANCE                         | -                                                |
| `OPS_READ`                    | See queue health, failed jobs, the outbox, inventory sync health and mappings, the maintenance flag, feature flags, and notification delivery and readiness                  | OPERATIONS                      | OPERATIONS                                       |
| `REFUND_REVIEW`               | See the refund queue and record a decision that moves no money                                                                                                               | REFUND_DESK, FINANCE            | -                                                |
| `REFUND_APPROVE`              | Approve a refund. Money leaves the platform (checked in `RefundsService`)                                                                                                    | FINANCE                         | -                                                |
| `ORGANIZER_REVIEW`            | Approve or reject organizers; suspend, delete, edit legal identity, set auto-approve                                                                                         | MODERATOR                       | -                                                |
| `EVENT_REVIEW`                | Approve or reject events, set event status                                                                                                                                   | MODERATOR                       | -                                                |
| `PLATFORM_CONFIG_READ` (#291) | See fee rules, tax rules, cinema pricing policies                                                                                                                            | FINANCE                         | FINANCE                                          |
| `PLATFORM_CONFIG`             | Change fee, tax and cinema pricing rules; maintenance mode; AI console; notification rates, resend and SNS; test sends                                                       | none                            | -                                                |
| `PAYOUT_MANAGE`               | Settlements (approve, release, block), payouts (pay, fail, reveal or verify accounts), payout terms                                                                          | FINANCE                         | -                                                |
| `PAYMENT_ADMIN`               | Payment provider config, routes, onboarding, promotion, outage; reconciliation findings resolve; unresolved-money recheck                                                    | none                            | -                                                |
| `ADMIN_MANAGE`                | Create back-office accounts and change their capabilities                                                                                                                    | none                            | -                                                |
| `OPS_EXECUTE`                 | Retry failed queue jobs; retry, batch-retry, cancel, park and recover outbox events; reprocess, park, retry, reconcile, re-map and reset the checkpoint of an inventory sync | OPERATIONS                      | OPERATIONS                                       |
| `FINANCE_APPROVE`             | Approve, retry or release the lease of a booking compensation, which lets it execute                                                                                         | FINANCE                         | FINANCE                                          |
| `FINANCE_RESOLVE`             | Run discrepancy detection; assign, resolve or ignore a discrepancy; park a compensation for manual review                                                                    | FINANCE                         | FINANCE                                          |
| `SUPPORT_MANAGE`              | Change the status (open, triaged, closed) of a support submission or complaint                                                                                               | SUPPORT                         | SUPPORT                                          |

Sensitive: `OPS_EXECUTE`, `FINANCE_APPROVE` and `FINANCE_RESOLVE` replay jobs and syncs, let
compensations execute, or close money findings. When they were split out of the reads, nobody was
granted them. The owner has since approved putting them in presets (see "Preset change approved
by the owner"). A preset applies only when somebody assigns it on Staff & duties. No migration
assigns a capability, and no existing account changed.

## Endpoints re-guarded in this change

| Route                                                    | Method | Before               | After               | Audit row (unchanged service code)                          |
| -------------------------------------------------------- | ------ | -------------------- | ------------------- | ----------------------------------------------------------- |
| `/admin/ops/queues/retry-failed`                         | POST   | OPS_READ (class)     | **OPS_EXECUTE**     | none today (follow-up)                                      |
| `/admin/ops/queues/jobs/:id/retry`                       | POST   | OPS_READ (class)     | **OPS_EXECUTE**     | none today (follow-up)                                      |
| `/admin/outbox/events/:id/retry`                         | POST   | OPS_READ (class)     | **OPS_EXECUTE**     | OUTBOX_RETRY                                                |
| `/admin/outbox/retry-batch`                              | POST   | OPS_READ (class)     | **OPS_EXECUTE**     | OUTBOX_RETRY_BATCH                                          |
| `/admin/outbox/events/:id/cancel`                        | POST   | OPS_READ (class)     | **OPS_EXECUTE**     | OUTBOX_CANCEL                                               |
| `/admin/outbox/events/:id/manual-review`                 | POST   | OPS_READ (class)     | **OPS_EXECUTE**     | OUTBOX_MANUAL_REVIEW                                        |
| `/admin/outbox/recover-stale-leases`                     | POST   | OPS_READ (class)     | **OPS_EXECUTE**     | OUTBOX_STALE_RECOVERY                                       |
| `/admin/inventory-sync/events/:id/reprocess`             | POST   | OPS_READ (class)     | **OPS_EXECUTE**     | SYNC_EVENT_REPROCESS                                        |
| `/admin/inventory-sync/events/:id/manual-review`         | POST   | OPS_READ (class)     | **OPS_EXECUTE**     | SYNC_EVENT_MANUAL_REVIEW                                    |
| `/admin/inventory-sync/providers/:code/retry-failed`     | POST   | OPS_READ (class)     | **OPS_EXECUTE**     | SYNC_RETRY_FAILED                                           |
| `/admin/inventory-sync/providers/:code/reconcile`        | POST   | OPS_READ (class)     | **OPS_EXECUTE**     | none today (follow-up)                                      |
| `/admin/inventory-sync/mappings/:id/resolve`             | POST   | OPS_READ (class)     | **OPS_EXECUTE**     | SYNC_MAPPING_RESOLVE                                        |
| `/admin/inventory-sync/providers/:code/checkpoint/reset` | POST   | OPS_READ (class)     | **OPS_EXECUTE**     | SYNC_CHECKPOINT_RESET                                       |
| `/admin/compensations/:id/approve`                       | POST   | FINANCE_READ (class) | **FINANCE_APPROVE** | COMPENSATION_APPROVED                                       |
| `/admin/compensations/:id/retry`                         | POST   | FINANCE_READ (class) | **FINANCE_APPROVE** | COMPENSATION_RETRIED                                        |
| `/admin/compensations/:id/release-lease`                 | POST   | FINANCE_READ (class) | **FINANCE_APPROVE** | COMPENSATION_LEASE_RELEASED                                 |
| `/admin/compensations/:id/manual-review`                 | POST   | FINANCE_READ (class) | **FINANCE_RESOLVE** | COMPENSATION_MANUAL_REVIEW                                  |
| `/admin/payments/finance/detect`                         | POST   | FINANCE_READ (class) | **FINANCE_RESOLVE** | PAYMENT_DISCREPANCY_DETECTION (records no actor; unchanged) |
| `/admin/payments/finance/discrepancies/:id/assign`       | POST   | FINANCE_READ (class) | **FINANCE_RESOLVE** | PAYMENT_DISCREPANCY_ASSIGNED                                |
| `/admin/payments/finance/discrepancies/:id/resolve`      | POST   | FINANCE_READ (class) | **FINANCE_RESOLVE** | PAYMENT_DISCREPANCY_RESOLVED                                |
| `/admin/payments/finance/discrepancies/:id/ignore`       | POST   | FINANCE_READ (class) | **FINANCE_RESOLVE** | PAYMENT_DISCREPANCY_IGNORED                                 |
| `/admin/support/:id`                                     | PATCH  | BOOKING_READ (class) | **SUPPORT_MANAGE**  | none today (follow-up)                                      |

These stay on the read capability on purpose:

- every GET on these controllers;
- `POST /admin/compensations/dry-run`, which runs the planner and saves nothing (FINANCE_READ).

### Verified still correct from #291

| Route                               | Read needs           | Write needs     |
| ----------------------------------- | -------------------- | --------------- |
| `/admin/fee-rules/**`               | PLATFORM_CONFIG_READ | PLATFORM_CONFIG |
| `/admin/tax-rules/**`               | PLATFORM_CONFIG_READ | PLATFORM_CONFIG |
| `/admin/cinema-pricing-policies/**` | PLATFORM_CONFIG_READ | PLATFORM_CONFIG |
| `/admin/ops/maintenance`            | OPS_READ             | PLATFORM_CONFIG |

`admin-config-authz.spec.ts` still passes, so these are still enforced.

### All other admin writes (audited, no change needed)

None of these rests on a read capability. The new `admin-surface.spec.ts` rule checks every one:

- **ADMIN_MANAGE:** staff routes.
- **ORGANIZER_REVIEW:** organizer review, suspension, delete, legal identity and auto-approve.
- **EVENT_REVIEW:** event review and status.
- **PLATFORM_CONFIG:** notification rates, resend, suppression lift, SNS reveal and confirm; readiness certification and test send.
- **PAYMENT_ADMIN:** payment config, routes, onboarding (11), promotion (4), outage (5), reconciliation-finding resolve, unresolved-money recheck.
- **PAYOUT_MANAGE:** settlements approve, release and block; payouts pay and fail; payout accounts reveal and verify; payout settings.

Over-restrictive reads, which are not defects:

- payment, payout and organizer-review pages need the write capability to view;
- SNS pending confirmation needs PLATFORM_CONFIG.

## Who lost access when the actions were split from the reads

Every row is a removal. Nobody gains anything.

### Per preset

| Preset                                                                             | Loses                                                                                                                                                                                                              | Keeps                                             |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| SUPPORT (BOOKING_READ, ORGANIZER_READ)                                             | Changing a support submission or complaint status (`PATCH /admin/support/:id`). The status buttons are replaced by a one-line note                                                                                 | Reading the inbox, bookings, payments, organizers |
| REFUND_DESK (+ REFUND_REVIEW)                                                      | Same as SUPPORT                                                                                                                                                                                                    | Same as SUPPORT, plus the refund queue            |
| FINANCE (BOOKING_READ, FINANCE_READ, REFUND_REVIEW, REFUND_APPROVE, PAYOUT_MANAGE) | Support status change; compensation approve, retry, release-lease and manual-review; discrepancy detection, assign, resolve and ignore. The "Run detection", "Resolve" and "Ignore" buttons are replaced by a note | All reads, refund approval, settlements, payouts  |
| MODERATOR                                                                          | Nothing                                                                                                                                                                                                            | Everything                                        |
| Any custom account holding `OPS_READ` (no preset grants it)                        | All 13 ops, outbox and inventory-sync actions above. The ops page's "Retry all failed" and per-job "Retry" are replaced by a note                                                                                  | Every ops read, and the maintenance flag (read)   |
| SUPER_ADMIN                                                                        | Nothing (holds every capability by role)                                                                                                                                                                           | Everything                                        |

### Per real account type (counted from code and seed; QA, UAT and production were not queried)

| Account                                                                        | Where it comes from                                                                                          | Effect                                                                                                                    |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `admin@eticketsgo.test`                                                        | `prisma/seed.ts`, roles ADMIN + SUPER_ADMIN, no grant rows                                                   | **Nothing lost**                                                                                                          |
| First admin on an empty install                                                | `first-admin.bootstrap.ts`, made SUPER_ADMIN                                                                 | **Nothing lost**                                                                                                          |
| `owner@`, `manager@`, `checkin@`, `customer1/2@eticketsgo.test`                | seed, organizer and customer roles                                                                           | **Not affected** (no admin capability involved)                                                                           |
| Temporary staff made by `apps/e2e/tests/qa-staff-assignment.spec.ts`           | grants BOOKING_READ, ORGANIZER_READ, REFUND_REVIEW to `customer1@` on QA, then revokes them in the same test | Would lose support status change while it exists. The test does not use it                                                |
| Any non-super staff created by hand on Staff & duties in QA, UAT or production | `AdminGrant` rows                                                                                            | Loses what its preset row above says. **The owner should check the Staff & duties list on each environment** before merge |

**What the owner needs to do after merge:**

- Anybody who must still retry jobs, replay the outbox or operate inventory sync needs `OPS_EXECUTE`.
- Anybody who must approve compensations needs `FINANCE_APPROVE`.
- Anybody who works the discrepancy queue needs `FINANCE_RESOLVE`.
- Anybody who closes complaints needs `SUPPORT_MANAGE`.

Grant these on Staff & duties. A super admin needs nothing. Since the approved preset change,
assigning FINANCE, SUPPORT or OPERATIONS grants them in one step. Accounts that already exist
keep what they hold until somebody assigns again.

## Preset change approved by the owner (2026-10-10, applied)

The source is `ADMIN_PRESETS` in `packages/shared-types/src/admin-permissions.ts`. The test
`apps/api/src/admin/admin-presets.spec.ts` pins each preset to exactly the list below.

| Preset      | Before                                                                   | After                                                           | Change                                                   |
| ----------- | ------------------------------------------------------------------------ | --------------------------------------------------------------- | -------------------------------------------------------- |
| FINANCE     | BOOKING_READ, FINANCE_READ, REFUND_REVIEW, REFUND_APPROVE, PAYOUT_MANAGE | before + FINANCE_APPROVE, FINANCE_RESOLVE, PLATFORM_CONFIG_READ | + 3; description now says what it does                   |
| SUPPORT     | BOOKING_READ, ORGANIZER_READ                                             | before + SUPPORT_MANAGE                                         | + 1; "Cannot change or delete anything" replaced (below) |
| REFUND_DESK | BOOKING_READ, ORGANIZER_READ, REFUND_REVIEW                              | unchanged                                                       | none (no SUPPORT_MANAGE)                                 |
| MODERATOR   | ORGANIZER_READ, ORGANIZER_REVIEW, EVENT_REVIEW                           | unchanged                                                       | none                                                     |
| OPERATIONS  | (did not exist)                                                          | OPS_READ, OPS_EXECUTE                                           | new preset, assigned to nobody                           |

New descriptions (ASCII):

- SUPPORT: "Can find any booking and see what happened to it, and mark a support message or
  complaint open, triaged or closed. Cannot change a booking, a refund or any money."
- FINANCE: "Sees the money and the fee and tax rules, approves refunds and compensations, works
  the discrepancy queue and releases settlements. Cannot change the fee or tax rules."
- OPERATIONS: "Watches the job queues, the outbox and inventory sync, and retries or replays work
  that failed. Cannot open bookings or payments, and moves no money."

No preset carries `PLATFORM_CONFIG`, `PAYMENT_ADMIN` or `ADMIN_MANAGE`. These are granted person
by person.

**Who changes on merge: nobody.** A preset applies only when somebody assigns it on Staff &
duties. That page sends the preset's list to `PUT /admin/staff/:userId/permissions`. No migration
or seed was changed, and no staff assignment was modified. An account that already holds the old
FINANCE bundle keeps exactly its five capabilities. The integration test proves this, and the
account is still refused FINANCE_APPROVE, FINANCE_RESOLVE and PLATFORM_CONFIG_READ.

### Tests

- `admin-presets.spec.ts` checks:
  - the set of presets, and each preset's exact capabilities;
  - that no preset carries `PLATFORM_CONFIG`, `PAYMENT_ADMIN` or `ADMIN_MANAGE`;
  - that the SUPPORT description is truthful;
  - that the new text is ASCII.

  **Load-bearing:** adding OPS_EXECUTE to SUPPORT fails it, and also fails the carrier check in
  `admin-action-authz.spec.ts`.

- `admin-presets.integration-postgres.spec.ts` runs against the real application and Postgres. A
  super admin assigns each preset through `PUT /admin/staff/:userId/permissions`. For each one,
  the test then checks three things:
  - the database rows, the staff list and the account's own `/auth/me` hold exactly the preset;
  - one probe per capability, through the real guards, is refused (403) exactly where the preset
    lacks that capability. There are 14 probes. The write probes name records that do not exist,
    or send bodies that validation rejects, so nothing changes;
  - an account given the old FINANCE bundle is unchanged.

  **Load-bearing:** removing `@RequiresAdmin(SUPPORT_MANAGE)` from `PATCH /admin/support/:id`
  fails it for FINANCE and REFUND_DESK. Without the decorator, those presets' BOOKING_READ opens
  the route.

- `admin-action-authz.spec.ts`:
  - for each of the 22 action routes, every current preset is allowed exactly when it carries
    the route's capability;
  - the carriers of the four action capabilities are exactly OPERATIONS, FINANCE, FINANCE and
    SUPPORT.

  The checks of the presets "as they were before approval" are kept. They describe what existing
  accounts still hold.

- `admin-config-authz.spec.ts`: no preset changes configuration. Only FINANCE reads it.

## QA staff, read on 2026-10-10 (read-only)

The QA admin API (`https://api-qa-f580.up.railway.app/api`) was read as `admin@eticketsgo.test`.
It took one sign-in (`POST /auth/login`), then GET requests only:

- `/auth/me`;
- `/admin/staff/catalogue`;
- `/admin/staff`;
- `/organizations`;
- `/users?role=ADMIN`.

Nothing was created, changed or deleted, and no assignment was touched.

- **Back-office accounts: one.** `admin@eticketsgo.test`, ACTIVE, `SUPER_ADMIN`, so it holds all
  17 capabilities by role. No non-super staff account exists. The temporary grants made by
  `qa-staff-assignment.spec.ts` are not present.
- **Unexpected: the super admin also carries the global `ORGANIZER_OWNER` role, but is a member of
  no organization** (`myRole` is null on all 7). The role is not tied to any organization. This
  is why the `@OrganizerOnly` door in the organizer-bypass fix checks membership and not the
  global role (see that PR).
- **The organizer bypass is live on QA.** `GET /organizations` returned all 7 organizations to the
  super admin, with `myRole: null`. This is the "every organization" answer the organizer-bypass
  fix removes.
- No ADMIN account without grants exists, and no non-super account holds a sensitive capability.
- QA still serves the old presets. The catalogue shows four presets: SUPPORT is "Cannot change or
  delete anything" and FINANCE has five capabilities. This change reaches QA only when it is
  deployed.

## Organizer role matrix (writes)

This is authorization **within an organization**. It uses `OrgAccessService.assertMember(user, orgId, roles?)`
on the caller's `OrganizationMember.role` in **that** organization. A membership role is one of
OWNER, MANAGER or CHECKIN_STAFF (`inviteMemberSchema`). Every organizer write outside `/admin` was traced:
controller, then service, then the check.

| Area                                                                                                                  | Owner | Manager | Check-in staff                                                                                                                              |
| --------------------------------------------------------------------------------------------------------------------- | ----- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Events, sessions, ticket types, images, seating, add-ons, bundles, coupons                                            | yes   | yes     | no                                                                                                                                          |
| Venues, cinemas, screens, seat classes, movies, show scheduling, pricing, pause and cancel, seat layouts, seat blocks | yes   | yes     | no                                                                                                                                          |
| Organization profile, logo, cover                                                                                     | yes   | yes     | no                                                                                                                                          |
| Legal identity, cash payments switch, member invite and resend                                                        | yes   | no      | no                                                                                                                                          |
| Payout bank account; refund approval; Stripe or Razorpay account linking                                              | yes   | no      | no                                                                                                                                          |
| Raise a payout (`/payouts/generate`)                                                                                  | yes   | yes     | no                                                                                                                                          |
| Check-in scan and visual admit; offline device register, reconcile, preflight                                         | yes   | yes     | yes (door functions)                                                                                                                        |
| Reverse a check-in; approve, suspend or revoke a device; drills; activation; resolve reconciliation                   | yes   | yes     | no                                                                                                                                          |
| Record cash at the counter (`POST /payments/:bookingId/collect-cash`)                                                 | yes   | yes     | yes. Deliberate (the door person holds the cash tin), scoped to the booking's own organization, PENDING_PAYMENT cash bookings only, audited |

**Clear defects found: none.** Nothing was changed on the organizer side. Every write checks the role
in the target organization, so an owner of org B who is only check-in staff in org A cannot change
org A.

Listed, not changed (product decisions):

- **Read exposure.** `GET /organizations/:id` and `GET /organizations/:id/legal-identity` accept any
  member, including check-in staff. These responses include tax registration, registered address,
  and finance and grievance contacts. Suggestion:
  - restrict legal identity to OWNER and MANAGER;
  - return fewer fields from `get`. Do not restrict `get` itself: other routes use it as a membership gate.
- **Route and service mismatch.** `@Roles` on Stripe and Razorpay linking lists MANAGER, but the
  service allows the owner only. This is harmless, because the service decides.
- **Defence in depth.** `collect-cash` calls `assertMember` with no role list. It is correct today
  because only three membership roles exist. Passing the list explicitly would keep it correct if a
  role is added.
- **Platform-admin bypass (most important follow-up).** `assertMember` lets any `ADMIN` through
  with **no capability check**. Any back-office account, even one holding no capability at all, can
  therefore call organizer-side writes for any organization. Two exceptions are covered:
  - refund approval is checked in `RefundsService`;
  - `/admin` routes have their own guard.

  The exposed writes include:
  - `POST /payouts/accounts` (payout bank account);
  - `POST /payouts/generate`;
  - `POST /payments/:id/collect-cash`;
  - legal identity;
  - event and coupon edits;
  - check-in reversal.

  `admin-surface.spec.ts` deliberately excludes these shared routes, because putting
  `@RequiresAdmin` on them would lock organizers out. The fix belongs in `OrgAccessService`, for
  example by requiring a named capability for platform staff acting inside an organization. It
  touches payout and payment paths, which this change may not modify, so it is reported here for
  an owner decision.

## Tests that enforce this

- `apps/api/src/admin/admin-action-authz.spec.ts` sends real HTTP through the real `RolesGuard` and
  `AdminPermissionGuard`, against the six re-guarded controllers. For **each** of the 22 writes:
  - the read holder it used to admit gets 403, the handler never runs, and no service is called;
  - an account holding **every** capability that existed before this change (ADMIN_MANAGE included) gets 403;
  - the FINANCE and SUPPORT presets get 403;
  - the new capability passes, and the caller's id reaches the service that writes the audit row;
  - each other new capability gets 403;
  - a super admin with no grant rows passes.

  It also checks:
  - every GET stays open to its read capability and closed to an action capability alone;
  - the dry run stays on FINANCE_READ;
  - no preset grants a new capability;
  - a reflection check fails if a write on these controllers is missing from the list or rests on a read capability;
  - with the **real** outbox and sync services, an allowed call records its audit row with the caller as actor, and a refused call writes nothing and audits nothing.

  **Load-bearing:** against the old controllers, 86 of these tests fail.

- `apps/api/src/auth/admin-surface.spec.ts` has a new rule: across **every** controller, no
  staff-only POST, PUT, PATCH or DELETE may resolve to a read capability. The one named exception is
  the compensation dry run. **Load-bearing:** removing the new decorator from `PATCH /admin/support/:id` fails it.
- `apps/admin-web/lib/capabilities.test.ts` checks that controls stay hidden from read-only holders
  and that the notes are ASCII.
