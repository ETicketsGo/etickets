# Admin permission matrix

Status: current as of branch `fix/admin-organizer-bypass` (base `main` eb4534b).
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
- **Defence in depth (fixed).** `collect-cash` now passes its three roles to `assertMember`
  explicitly, so it stays correct if a membership role is added.
- **Platform-admin bypass (fixed).** See "Organizer API: platform staff" below.

## Organizer API: platform staff

### Root cause

`OrgAccessService.assertMember` returned early for any account with the `ADMIN` or `SUPER_ADMIN`
role. It did not look up a membership and it did not check a capability. Every organizer route
asserts membership through it. So a back-office account **holding no capability at all** could do
all of the following, for **every** organization:

- save the payout bank account (`POST /payouts/accounts`);
- raise a payout (`POST /payouts/generate`);
- record cash at the counter (`POST /payments/:bookingId/collect-cash`);
- rewrite legal identity (`PATCH /organizations/:id/legal-identity`);
- link a Stripe or Razorpay payout account;
- create, edit, publish, pause and delete events, sessions, ticket types, coupons, add-ons,
  bundles, venues, cinemas, screens, seat layouts and shows;
- invite team members, including a new OWNER;
- reverse check-ins and approve check-in devices;
- read every organizer report, payout figure, attendee list and export.

`managedOrganizationIds` returned "every organization" for staff, so the organizer console listed
all of them. Four services also had their own `isPlatformAdmin` shortcut: event and analytics
money fields, attendee contact details, refund requests and refund lists.

### The rule now

1. **Membership decides.** A member with an allowed role passes, as before. This includes a staff
   account that is also a member. Members are not audited as platform access.
2. **A platform role alone opens nothing.** A staff account that is not a member passes only
   where the call site names a `PlatformPolicy` (`{ permission, operation }`) and the account
   holds that capability. Most call sites name no policy, so most operations are closed to staff
   **by default**. A new organizer route is therefore safe even if nobody remembers to close it.
3. **Every staff attempt is audited**, allowed or refused. See "Audit rows".
4. **Money and identity routes refuse staff at the door.** On a route marked `@OrganizerOnly`,
   `OrganizerOnlyGuard` refuses a staff account before the handler runs, and records the attempt.
   The guard runs before `RolesGuard`. `ADMIN` and `SUPER_ADMIN` are removed from the `@Roles` of
   these routes. One exception: a staff account that is an ACTIVE member of some organization
   (because it registered its own) goes on to the handler. There, membership of the target
   organization decides. The door checks membership, not the global `ORGANIZER_*` role. The
   seeded super admin on QA carries `ORGANIZER_OWNER` but belongs to no organization, and a role
   check would let it past.
5. **Super admin.** A super admin holds every capability by role, so it passes every **named**
   policy below. Where no policy is named, it is refused. At the `@OrganizerOnly` door it is
   refused like any other staff account. There is no "super admin can do anything on the
   organizer API" path. Each operation a super admin can perform is listed in the next table, and
   each one is audited.
6. **The organization is resolved on the server.** Each check uses the organization of the
   resource (event, ticket, booking, device, session). It never uses an id that the client sends
   next to the resource. One route got this wrong and is fixed here (see "Cross-organization
   ids").

No new capability was added. Nothing was granted to anybody.

### What platform staff may do on the organizer API

| Route                                                    | Capability       | Operation (audit)           | Why                                              |
| -------------------------------------------------------- | ---------------- | --------------------------- | ------------------------------------------------ |
| `GET /organizations/:id` (also `/readiness`, `/actions`) | `ORGANIZER_READ` | `organization.read`         | Admin console organizer page                     |
| `GET /organizations/:id/members`                         | `ORGANIZER_READ` | `organization.members.read` | Admin console organizer page                     |
| `GET /events/:id`                                        | `ORGANIZER_READ` | `event.read`                | Admin console event page                         |
| `DELETE /events/:id`                                     | `EVENT_REVIEW`   | `event.delete`              | Admin console Delete, no bookings (moderation)   |
| `GET /refunds/booking/:bookingId`                        | `BOOKING_READ`   | `refund.list-for-booking`   | Admin console booking page                       |
| `POST /refunds/:id/process`                              | `REFUND_APPROVE` | `refund.decide`             | Admin refund queue (same rule, now also audited) |

**Nothing else.** Every other organizer operation is refused to staff who are not members. Staff
do these on `/admin` instead, where each has its own capability:

- payout accounts: reveal and verify need `PAYOUT_MANAGE`;
- legal identity needs `ORGANIZER_REVIEW`;
- event status needs `EVENT_REVIEW`;
- refunds need `REFUND_REVIEW` or `REFUND_APPROVE`.

### Refused at the door (`@OrganizerOnly`) for every staff account, super admin included

| Route                                                      | Operation (audit)                    |
| ---------------------------------------------------------- | ------------------------------------ |
| `POST /payouts/accounts`                                   | `payout.account.save`                |
| `POST /payouts/generate`                                   | `payout.generate`                    |
| `POST /payments/:bookingId/collect-cash`                   | `cash.collect`                       |
| `PATCH /organizations/:id/legal-identity`                  | `organization.legal-identity.update` |
| `/organizers/:organizerId/payments/stripe/*` and `/status` | `payments.stripe-connect`            |
| `/organizers/:organizerId/payments/razorpay/*`             | `payments.razorpay-route`            |
| `GET /organizations/:organizationId/receipts`              | `organization.receipts.list`         |
| `GET /organizations/:organizationId/refunds`               | `organization.refunds.list`          |

### Every other route

`apps/api/src/tenancy/organizer-route-policy.spec.ts` lists **all 226** non-admin, non-public
routes, each with its staff policy. If a route is added without an entry, the build fails. The
policies are:

- `NONE`: organizer operations. The tenant check refuses staff, and the refusal is audited. This
  covers:
  - events, sessions, ticket types, images and seating;
  - add-ons, bundles and coupons;
  - venues, spaces, cinemas, screens, seat classes, movies, shows, pricing, seat layouts and seat
    blocks;
  - check-in, offline devices, drills, activation, reconciliation and the command center;
  - the calendar, reports, analytics, attendees and exports, and the organizer AI;
  - payout reads and receipts;
  - the organization profile, logo, cover, cash switch and team invites.
- `ORGANIZER_ONLY`: the routes in the table above.
- `SELF`: the caller's own account, bookings and tickets.
- `ADMIN_ROUTE`: `GET /users` and `GET /users/directory-summary` (`@RequiresAdmin(BOOKING_READ)`).
- `CUSTOMER_RESOURCE`: the buyer only; staff read a booking on `GET /admin/bookings/:id`.

### Organizer members (no regression)

The organizer role matrix above is unchanged. Real HTTP tests prove that:

- the owner can save the bank account and edit legal identity and events;
- the manager can edit events and read payouts, and cannot change the bank account or legal
  identity;
- check-in staff can read their organization and reach collect-cash. They cannot edit events,
  read payouts or raise a payout;
- the owner of another organization is refused everything, even when the request names that
  owner's own organization.

### Payout bank account safeguards

Found:

- The account number is encrypted at rest (`PAYOUT_BANK_ENCRYPTION_KEY`). The API shows only
  the last 4 digits.
- Saving an account clears any earlier verification.
- The save is audited (`PAYOUT_ACCOUNT_SAVED`, last 4 digits only).
- Verify and reveal are on `/admin/payouts`. They need `PAYOUT_MANAGE` and are audited. A reveal
  needs a reason.

Gaps found, and where each stands:

- **Maker-checker (closed by the bank-account safeguards change).** The person who verifies or
  rejects an account must not be the person who saved it, and must not be a member of the
  organization. Enforced in `PayoutAccountsService`, and again by a database check constraint
  (`OrganizerPayoutAccount_checker_not_maker`) so a code path that forgets the rule is still
  refused. A refusal is audited (`outcome: REFUSED`, `reasonCode: SAME_PERSON` or
  `ORGANIZATION_MEMBER`). Verification also names the version it checked: details saved after the
  reviewer looked are refused (409), so a swapped number cannot ride on an earlier check.
- **Owner notice (closed).** Every save, verification and rejection emails and notifies every
  organization OWNER (`PAYOUT_ACCOUNT_UPDATED`) with a masked summary and "if this was not you"
  guidance. No full number is ever in a notification payload.
- **Change history (closed).** Every save is a row in `OrganizerPayoutAccountVersion`: who, when,
  which fields changed, last four digits only. There is no ciphertext column on it.
- A changed account can receive a payout at once. There is no cooling-off period and no second
  approval. **Still open in this change:** payout execution does not look at verification. The
  hold is a separate change that needs owner approval.

Blocked: `POST /payouts/accounts` for every platform staff account, super admin included. The
owner's own flow is unchanged.

### Audit rows

`PLATFORM_ORGANIZER_ACCESS_ALLOWED` is written when a staff account passes a named policy.
`PLATFORM_ORGANIZER_ACCESS_DENIED` is written when the tenant check or the door refuses a staff
account. Both rows carry:

- `actorUserId`;
- `organizationId`: the resource's organization;
- `entityType` and `entityId`;
- `correlationId`;
- `metadata`: `result`, `operation`, `permission`, `reason` and `request`.

`reason` is `CAPABILITY_HELD`, `CAPABILITY_MISSING` or `NO_PLATFORM_POLICY`. Where no policy is
named, `operation` is the request line, for example `PATCH /api/events/...`.

At the door, the organization recorded is the one the request **names**, and the row says so. The
request is refused whatever it names. For collect-cash, the row records the booking id instead.
Members are not audited as platform access. Their writes keep the audit rows they had before.

### Cross-organization ids

Every organizer route that takes an organization id together with a resource id was checked.
Each one either checks that the resource belongs to that organization or takes the organization
from the resource. The exceptions:

- **Fixed:** `POST /checkin/command-center/alerts/ack`. A manager of org A could send org A's id
  with a session id of org B. This acknowledged org B's live gate alerts, or overwrote who had
  acknowledged them. The session's organization is now checked first.
- **Fixed:** `GET /checkin/offline-readiness` and `GET /checkin/activation` read the manifest by
  session only. This leaked one bit about another organization's session. They now also filter
  by organization.
- **Not fixed (low risk, data only):** `POST /checkin/devices` and `POST /checkin/drills` store an
  event or session id without checking it. Every read is scoped to the caller's organization, so
  nothing of the other organization can be read or changed.

### Not changed, reported

- **Customer resources reached by staff role.** Fixed; see "Customer resources: platform staff".

- **`POST /refunds` by staff is now refused.** Staff could open a refund request as `staff` on any
  customer's booking. That lifts the transferred-ticket rule, and on a free booking it cancels the
  tickets at once. No console uses it. The owner should decide which capability, if any, opens it.
- **Razorpay linked-account id.** Nothing stops two organizations from linking the same `acc_...`
  id.
- **Payout scope bug (payout code, not touched here).** In `payouts.service.ts`, three queries
  have the same bug: `payableBookingWhere`, the refund query and the held-revenue query. Each one
  spreads `eventId: scope.eventId`, and then `eventId: { notIn: transferredEventIds }` overwrites
  it. Suppose an event-scoped payout is raised for an event with a claimed settlement. The payout
  then settles the bookings of every other event. This should not be reachable while provider
  transfers are off. The fix is to combine the two conditions with `AND`.
- **Event detail needs `ORGANIZER_READ`.** The admin event page opens with `EVENT_REVIEW`, but it
  reads the event with `ORGANIZER_READ`. The MODERATOR preset holds both. A custom account with
  only `EVENT_REVIEW` is now refused on that page.

## Customer resources: platform staff (fixed in this change)

### Root cause

Ten customer-facing checks read the `ADMIN` / `SUPER_ADMIN` role directly. A back-office account
granted no capability at all passed them, as if it were the buyer, and left no record. Some were
writes: cancel a booking, open a payment, assign, invite, transfer or unassign an attendee, create
or change a share link.

### Policy per route, before and after

"Staff" means any account holding `ADMIN` or `SUPER_ADMIN`, with any grants or none. "Buyer" is the
account on the booking (for a ticket: its current holder). Organizers have no access to these
routes at all; their organization-scoped routes are in "Organizer API: platform staff".

| Route                                                                                               | Staff before            | Staff after | Customer A on B's resource | Organizer   |
| --------------------------------------------------------------------------------------------------- | ----------------------- | ----------- | -------------------------- | ----------- |
| `GET /bookings/:id`                                                                                 | allowed, by role        | 403         | 403                        | 403         |
| `POST /bookings/:id/cancel` (unpaid)                                                                | allowed, by role        | 403         | 403                        | 403         |
| `POST /bookings/:id/pay`                                                                            | allowed, by role        | 403         | 403                        | 403         |
| `POST /bookings/:id/payments/razorpay/verify`                                                       | allowed, by role        | 403         | 403                        | 403         |
| `POST /bookings/:id/coupon`, `/extend-hold`                                                         | 403 (owner only)        | 403         | 403                        | 403         |
| `GET /tickets/:id`                                                                                  | allowed, by role        | 403         | 403                        | 403         |
| `POST /tickets/:id/attendee`, `/invite`, `/transfer`, `/unassign`                                   | allowed, by role        | 403         | 403                        | 403         |
| `POST /attendee-invites/:id/resend`                                                                 | allowed, by role        | 403         | 403                        | 403         |
| `GET /bookings/:id/attendees`                                                                       | allowed, by role        | 403         | 403                        | 403         |
| `POST /tickets/:id/share`, `GET /tickets/:id/shares`, `POST /shares/:id/{revoke,extend,permission}` | allowed, by role        | 403         | 403                        | 403         |
| `POST /wallet/passes` (reads the ticket through `GET /tickets/:id`)                                 | allowed, by role        | 403         | 403                        | 403         |
| `POST /refunds`                                                                                     | 403 since #313          | 403         | 403                        | 403         |
| `GET /refunds/booking/:id`                                                                          | `BOOKING_READ`, audited | unchanged   | 403                        | 403         |
| `GET /bookings/guest/*`, share-link resolve, attendee-invite accept                                 | token, not role         | unchanged   | token                      | token       |
| `GET /users/me`, `PATCH /users/me`, `DELETE /users/me`                                              | own account only        | unchanged   | own account                | own account |

The buyer keeps every route above for their own resources. The booking owner check is `userId ===
caller`, and the ticket check is the current holder (the buyer, or the latest transfer's recipient).

### The one explicit support path

`GET /admin/bookings/:id` (`BOOKING_READ`, the class guard) returns the same view the buyer gets.
Every read writes `PLATFORM_ORGANIZER_ACCESS_ALLOWED` with operation `booking.admin-read`, the
booking's organization, the booking id, the actor and the correlation id. The admin console's
booking page now calls it. The refund list on that page keeps using `GET /refunds/booking/:id`,
which already checks `BOOKING_READ` and audits (see `refunds.service.ts`). Holders of
`BOOKING_READ`: the SUPPORT, REFUND_DESK and FINANCE presets and super admin.

### Support workflows affected

- **View a customer's booking: kept**, through the route above. No capability was added.
- **Cancel a customer's unpaid booking on their behalf: removed, no admin equivalent.** It was only
  reachable by calling the customer route (the console has no button). An unpaid hold expires by
  itself. If support needs this, it needs its own admin route with a capability and a reason. It is
  not built here.
- **Read a customer's ticket, QR or attendee details: removed, no admin equivalent.** The booking
  view lists the tickets with their serial, status and seat. The QR and the attendee's contact
  details are the buyer's.
- **Act on a ticket whose holder cannot be named** (a guest booking, or a legacy transfer with no
  recipient): nobody can now. Before, staff could, by role. This is a deliberate fail-closed
  default and is a gap if support gets such a case.
- **Open a payment or verify a payment for a customer: removed.** Nothing used it.

### Audit coverage added for operational mutations

Every row carries `actorUserId`, `entityType`, `entityId`, `correlationId` (the request's id), the
timestamp, and `metadata.outcome`: `ALLOWED` when the operation ran to the end and `FAILED` when it
threw (the error class only, never its message). Metadata holds counts, ids and status names, no
customer or payment data.

| Action                          | Route                                                     | Capability        |
| ------------------------------- | --------------------------------------------------------- | ----------------- |
| `OPS_QUEUE_RETRY_ALL`           | `POST /admin/ops/queues/retry-failed`                     | `OPS_EXECUTE`     |
| `OPS_QUEUE_RETRY_JOB`           | `POST /admin/ops/queues/jobs/:id/retry`                   | `OPS_EXECUTE`     |
| `SYNC_RECONCILE_RUN`            | `POST /admin/inventory-sync/providers/:code/reconcile`    | `OPS_EXECUTE`     |
| `SUPPORT_TICKET_STATUS_CHANGED` | `PATCH /admin/support/:id` (from, to)                     | `SUPPORT_MANAGE`  |
| `NOTIFICATION_RATE_CREATED`     | `POST /admin/notifications/analytics/rates`               | `PLATFORM_CONFIG` |
| `NOTIFICATION_RATE_SUPERSEDED`  | `POST /admin/notifications/analytics/rates/:id/supersede` | `PLATFORM_CONFIG` |
| `PAYMENT_DISCREPANCY_DETECTION` | `POST /admin/payments/finance/detect`                     | `FINANCE_RESOLVE` |

The last one already existed but was written with no actor; it now names the person who ran it.
Refusals by the capability guard are not audited (the guard runs before any handler); that is the
existing behaviour for every admin route.

The grep of every other admin and ops mutation found each one audited already (payment config,
routes, outage, onboarding, promotion, settlement, payouts, outbox, notification resend, SNS
confirmation, staff grants, tax rules, fee rules, pricing policies, organization review).

### Found while auditing, fixed

`POST /admin/notifications/analytics/rates/:id/supersede` read the id from the query string
(`@Query('id')`) although the id is in the path. It was always `undefined`, and Prisma treats
`id: undefined` as no filter, so the call ended **every open rate** instead of one. It reads the
path now and refuses a missing id.

### Not changed, reported

- The refund list route for staff is a customer route that admits staff by capability. A separate
  `/admin/bookings/:id/refunds` would be cleaner; it was left so the console keeps working.
- Failed capability checks on admin routes are not audited. Only the organizer-API refusals are.

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
- `apps/api/src/tenancy/organizer-platform-access.integration-postgres.spec.ts` drives the real
  application with real signed tokens and real Postgres. It tests six staff accounts: zero grants,
  every read, the FINANCE preset, the SUPPORT preset, the MODERATOR preset and super admin. Each
  is refused:
  - the bank account, payout generation and collect-cash;
  - legal identity and Razorpay linking;
  - payout account reads, event edits and team invites.

  For each refusal the test reads Postgres back to prove nothing was written, and checks the
  audit row. The two documented reads and the EVENT_REVIEW delete are allowed and audited. Owner,
  manager, check-in staff and another organization's owner are also tested.

  **Load-bearing:**
  - old bypass, old `@Roles` and the door disabled: 44 of its then 60 tests fail;
  - the bypass alone restored: 29 tests fail across this spec and the unit spec;
  - the door alone disabled: 6 tests fail;
  - the door checking the global organizer role instead of membership: the QA-shaped super admin
    (with `ORGANIZER_OWNER` and no organization) gets past it, and 2 tests fail. One of them is
    collect-cash, where the handler ran and answered 404.

- `apps/api/src/tenancy/organizer-route-policy.spec.ts` checks every non-admin route against its
  written staff policy:
  - the `@OrganizerOnly` door is on exactly the ORGANIZER_ONLY routes;
  - `ADMIN` appears in `@Roles` only where it is allowed;
  - every `{ permission, operation }` in production code is documented.

  **Load-bearing:** removing the door from `POST /payouts/generate` fails it. So does renaming a
  documented operation.

- `apps/admin-web/lib/capabilities.test.ts` checks that controls stay hidden from read-only holders
  and that the notes are ASCII.

- `apps/api/src/tenancy/customer-resource-isolation.integration-postgres.spec.ts` sends real HTTP
  through the whole application with real tokens and Postgres:
  - five staff shapes (zero grants, every read, SUPPORT, FINANCE, super admin) and another customer
    are refused on all 20 customer routes above, and the booking, ticket, invites and refunds are
    read back unchanged;
  - an organizer owner is refused on the customer routes of a booking in their own organization,
    and the owner of organization A is refused organization B's print, collect-cash and buyer
    routes; the owner of A still prints A's booking;
  - the buyer still reads, shares, assigns an attendee and cancels their own booking;
  - `GET /admin/bookings/:id` is refused to zero grants, customers and organizers, and allowed and
    audited for SUPPORT, FINANCE, a read-only account and super admin;
  - each new audit action is written with actor, entity, correlation id and outcome (including a
    FAILED row for a job that does not exist), and is not written when the capability guard
    refuses; the support row carries statuses only; superseding one rate leaves the others open.
- `apps/api/src/bookings/booking-cancel.spec.ts` and `payments/finance/finance-reconciliation.spec.ts`
  cover the unit-level cancel refusal and the detection actor.
