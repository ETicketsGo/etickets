# Readable references

What a customer or a staff member is given to name a record, how each is made, and what the
owner must do in production. Written 2026-10-25 with branch `feat/readable-references`.

## Why

Production mail showed database ids and generated hosts:

- the acknowledgement said "Your reference is cmvncaxg10015uo2zxo94825e" (a cuid);
- the support inbox copy showed the same cuid as "Reference" and linked to
  `https://admin-web-prod-1594.up.railway.app/admin/support?q=<cuid>`;
- the footer of every mail named `customer-web-prod.up.railway.app`.

## Formats

| Record          | Format                       | Example               | Status                     |
| --------------- | ---------------------------- | --------------------- | -------------------------- |
| Booking         | `ETG-<COUNTRY>-<YEAR>-<SEQ>` | `ETG-IND-2026-000076` | Unchanged (ADR-030)        |
| Support request | `ETG-SUP-<YEAR>-<SEQ>`       | `ETG-SUP-2026-000142` | New (this change)          |
| Refund          | none of its own (see below)  | -                     | Follow-up, not implemented |

`<SEQ>` is at least six digits, zero padded. It grows to seven digits after 999999 and is never
cut. `<YEAR>` is the **UTC** year of the record's `createdAt`: 31 December 23:59:59 UTC is the old
year and 1 January 00:00:00 UTC is the new one, in every time zone (05:29 IST on 1 January is
still the old year). The sequence restarts at 000001 each year.

## How a support reference is made

- Table `ReadableReferenceCounter (scope PK, value, updatedAt)`, one row per scope. Support uses
  scope `SUP-<YEAR>`. It is a separate table from `BookingReferenceCounter`, so nothing about
  bookings changes.
- SQL function `etg_next_reference_value(scope)`: one
  `INSERT ... ON CONFLICT (scope) DO UPDATE SET value = value + 1 RETURNING value`. One
  statement, so it is atomic. The row lock makes a concurrent caller wait for the first
  transaction. If the transaction rolls back, the number is given back. No random numbers and
  no `max()+1`.
- The API (`apps/api/src/support/support-reference.ts`, called from `SupportService.submit`)
  calls that function **inside the transaction that inserts the request**, and writes
  `createdAt` with the same instant, so the year in the reference is the year the row says.
- A `BEFORE INSERT` trigger on `Feedback` (`feedback_assign_reference`) fills the reference
  for any insert that does not name one: the API from before this change (during the rollout),
  seeds and hand-written SQL. It uses the same function and the same counter, so the two paths
  cannot hand out the same number.
- `Feedback.reference` has a UNIQUE index and a CHECK on its shape
  (`^ETG-SUP-[0-9]{4}-[0-9]{6,}$`).
- `Feedback.id` stays the primary key. All relations and API fields are unchanged.
  `POST /support` now answers `{ id, reference, status }` (it was `{ id, status }`). The admin
  list rows carry `reference`.

## Migration and backfill

Migration `apps/api/prisma/migrations/20261025120000_support_request_reference`. It is additive.

1. It adds `Feedback.reference TEXT NULL`, the unique index and the shape CHECK.
2. It creates `ReadableReferenceCounter` and `etg_next_reference_value`.
3. It creates the trigger.
4. Backfill: only rows with `reference IS NULL`. The rows are numbered per UTC year of
   `createdAt`, oldest first, with `id` to break ties. Numbering starts after the highest number
   already used in that year, in a reference or in the counter. If you run it again, it
   assigns nothing.
5. It sets each year's counter to the highest number in use, and never lowers a counter.
   New references continue after the backfilled ones.

**Why the column stays nullable.** The safest choice for a live database. An API older than
this change does not name the column. A `NOT NULL` column without a default would break the
old API's inserts during the deploy window. The trigger already makes a missing value
impossible in practice. A later `SET NOT NULL` is possible after the new API is live and
`SELECT count(*) FROM "Feedback" WHERE reference IS NULL` returns 0. It is not needed, and it is
not part of this change.

The migration was proven on a database at the previous migration with five existing rows (two
years, a tie, and a row at 23:59:59.999 on 31 December). The backfill gave 2025-000001..000002 and
2026-000001..000003. A second run updated 0 rows. Then an insert in the old API's shape (no
reference) got 2026-000004 from the trigger.

## Rollout order

1. **Backup gate:** take and verify a fresh production backup before the deploy, as for every
   production migration.
2. Deploy the **api** service at the PR's merge SHA (pinned deploy). Its pre-deploy step runs
   the migration. The old api keeps working against the migrated database: the column is
   nullable and the trigger numbers its inserts.
3. Deploy the **worker** at the same SHA. A worker from before this change renders queued
   support mails correctly too. It reads `payload.reference`, which is now the readable
   reference, so only the subject brackets are missing until the worker is updated.
4. Deploy **admin-web** (reference column, detail row, search hint) and **customer-web** (the
   contact form shows the reference after sending). The order does not matter: both only read
   the new field when it is there.

## Lookup compatibility

The admin search (`/admin/support?q=`, and `GET /admin/support?q=` in the API) matches:

- the request's **id**, exactly. Old mails quoted the id and linked to `?q=<id>`, and those
  still find their request;
- the **reference**, exactly, in any case. The search also accepts the reference without dashes
  or leading zeros: `etgsup2026000142` and `ETG-SUP-2026-142` both find `ETG-SUP-2026-000142`;
- part of a reference (`2026-0001`), plus the message, subject and email, as before.

The admin link in the inbox copy uses `?q=<reference>`. A row without a reference (none after
the backfill) falls back to the id in both mails and in the link. Notification rows carry
`payload.reference` (readable) and `payload.feedbackId` (the id, for tracing). The notification
ops search by reference therefore finds support mails by `ETG-SUP-...` too.

## Emails

- Inbox copy: `New contact message [ETG-SUP-2026-000142]: <subject>` (or
  `... [ETG-SUP-2026-000142] from <sender>` when there is no subject). The "Reference" row
  shows the readable reference.
- Acknowledgement: `We have your message [ETG-SUP-2026-000142]`. The body says "Your reference
  is ETG-SUP-2026-000142."
- fr-CA has the same, from the French catalogue.
- Preview: `npm run email:preview -w @eticketsgo/api`, then open
  `SUPPORT_REQUEST_RECEIVED.html` / `SUPPORT_REQUEST_ACKNOWLEDGED.html`.

## Official domains in production emails (owner action)

**Where the hosts come from.** Configuration, not code. Every link and the footer host come from
environment variables on the services that build and send mail:

| Variable            | Used for in mail                                                                                                                                                         | Read by     |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------- |
| `CUSTOMER_WEB_URL`  | the footer "Visit the help centre" link and the host printed under it (`email.channel.ts` -> `redirectUrl(..., '/help')`); ticket, guest-access and password-reset links | api, worker |
| `ADMIN_WEB_URL`     | "Open in the admin console" in the support inbox copy (`support-mail.service.ts`)                                                                                        | api         |
| `ORGANIZER_WEB_URL` | organizer console links (invites, approvals)                                                                                                                             | api, worker |

The support inbox copy is **queued by the api** with its admin link already in the payload. The
**worker** renders each mail and adds the footer from its own `CUSTOMER_WEB_URL`. Both services
need the change.

**Required production changes.** Set these on **both** the production `api` and `worker`
services:

```
CUSTOMER_WEB_URL=https://www.eticketsgo.com
ADMIN_WEB_URL=https://admin.eticketsgo.com
ORGANIZER_WEB_URL=https://organizer.eticketsgo.com
```

(`deploy/railway/env/production.env.example` shows `https://eticketsgo.com` for the storefront.
Use the canonical host the storefront serves. The task names `https://www.eticketsgo.com`.)

Before you change them, check these:

- `CORS_ORIGINS` on the api already lists `https://www.eticketsgo.com`,
  `https://admin.eticketsgo.com` and `https://organizer.eticketsgo.com`. These are the origins
  people already use, so they should be there. Do not remove the generated hosts in the same
  change.
- `CUSTOMER_WEB_URL` also sets where Razorpay returns a buyer after paying
  (`razorpay-order.service.ts`, unless `RAZORPAY_CALLBACK_URL` is set) and the password-reset
  and guest links. The official host serves the same storefront, so this is the intended
  result. Prove it with one QA-style walk after the change.
- `PUBLIC_API_URL` is **not** part of this. It signs the Twilio and SNS webhook URLs. Changing
  it means changing those provider settings too, so it is a separate decision.

**How to change them.** A Railway variable change **redeploys latest `main`** unless deploys are
skipped. Use the pinned procedure only: `C:\etg-wt\prod-deploy-kit\set-var.mjs` (skipDeploys),
then `redeploy-same.mjs` (or a pinned deploy of the approved SHA), on api and worker. Then check
the result with `scripts/deploy/verify-deployed.mjs`. Never use the dashboard's plain save.

**The boot warning.** From this change, an api or worker running with `APP_ENV=PRODUCTION`
logs a WARNING at boot for each of these three variables that points at `*.up.railway.app`. The
warning names the variable and the value it should be (`common/email-host-warnings.ts`). It is a
warning, not a boot refusal. A refusal would take production down on its next deploy for a
fault that is only cosmetic. Nothing is rewritten silently either: no `PUBLIC_*` variable for
the web origins exists on the api, so there is nothing to prefer, and the configuration stays
the single source of truth. QA and UAT are not checked (`APP_ENV` other than `PRODUCTION`). They
use their own `*.eticketsgo.com` hosts per `deploy/railway/env/{qa,uat}.env.example`.

## Refunds: decision

A refund has **no customer-facing identifier of its own** today. The customer and the mails name
the **booking** reference (`ETG-IND-2026-000076`), and `Refund.id` is a cuid shown only to staff.
To add `ETG-RFD-<YEAR>-<SEQ>`, the number must be taken **in the refund-creation transaction**.
That transaction is the money path (`apps/api/src/refunds/`, the cancellation refunds and the
provider refund state machine). This change must not touch it, so refund references are **not
implemented**.

Proposed follow-up design. It needs a separate change with its own review:

1. Add `Refund.reference TEXT NULL UNIQUE` with CHECK `^ETG-RFD-[0-9]{4}-[0-9]{6,}$`.
2. Add a `BEFORE INSERT` trigger on `Refund`, the same as `feedback_assign_reference`, with scope
   `RFD-<YEAR>` taken from `etg_next_reference_value`. The year is the UTC year of the refund's
   `createdAt`. With the trigger, **no refund-creation code has to change**: the number is taken
   in the same transaction as the insert, whatever code path inserts it.
3. Backfill and seed the counter as in this migration.
4. Show it in refund mails and receipts, and add it to admin refund search. Only these read
   paths change.

## Account deletion: decision

There is **no distinct deletion-request record**. Deletion is self-service and immediate
(`apps/api/src/users/account-deletion.service.ts`, which anonymises and removes data in one
step). The public page `apps/customer-web/app/[locale]/delete-account/page.tsx` sends people who
cannot sign in to the **contact page**, and that page creates a normal support request. Those
requests therefore get an `ETG-SUP-...` reference like any other message. We did not invent a
separate `ETG-DEL` record.

## Known gap: privacy policy version in consent records

Production customer-web shows privacy policy **v2** (effective 2026-10-25) since deployment
9d155e9d/50aecd72. The production **API** still runs commit `2439e254`. In that commit, the policy
registry (`packages/shared-types/src/legal.ts`) has PRIVACY **v1** as current. Marketing-email
consent records that the production API creates
(`apps/api/src/notifications/marketing-consent.controller.ts`, `policyVersion` from
`getApplicablePolicy('PRIVACY', ...)`) therefore cite **v1**. This lasts until the API is
redeployed, which needs separate owner approval. No data is lost. v1 stays in the registry as
superseded, so every such record still resolves to the text it names.
