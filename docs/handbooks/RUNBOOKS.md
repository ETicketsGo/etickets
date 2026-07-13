# ETicketsGo — Runbooks

> Operational task recipes for **local / dev** work. Honest about what exists:
> anything not yet built is marked **planned**. Companions:
> [Developer Handbook](./DEVELOPER-HANDBOOK.md),
> [Architecture Handbook](./ARCHITECTURE-HANDBOOK.md).

---

## Start the full stack

```bash
docker compose up -d          # Postgres :5432 + Redis :6379 (healthchecked)
npm run dev                   # API :4000, customer :3000, organizer :3001, admin :3002
npm run dev -w @eticketsgo/worker   # worker (health :4100) — separate terminal
```

`npm run dev` runs the API and all three web apps under Turbo in watch mode. The
worker is a separate process; run it when you need hold expiry / notification
dispatch. Verify: `curl http://localhost:4000/api/health`.

## Stop the full stack

- Stop `npm run dev` / worker with `Ctrl+C` in each terminal. The worker handles
  `SIGINT`/`SIGTERM` gracefully (closes the BullMQ worker + queue, Redis, health
  server, then the Nest context).
- Stop the databases: `docker compose stop` (keeps data) or `docker compose down`
  (keeps the named volumes `db-data` / `redis-data`; add `-v` to wipe them).

> **Windows:** stop the API and worker **before** any Prisma command — a running
> Node process locks the Prisma query engine and `migrate`/`generate` will fail.

## Apply a migration

```bash
# stop API + worker first (Windows engine lock)
npm run db:migrate            # prisma migrate dev — create + apply, prompts for a name
```

To apply already-committed migrations without prompts (CI / a fresh clone):

```bash
npm run db:deploy             # prisma migrate deploy
```

Migrations live in `apps/api/prisma/migrations/`. Keep every migration **additive**
where possible (new columns/tables, nullable FKs, no drops) — that is the
backward-compatibility rule the Experience/Movie/Seat ADRs rely on.

## Seed / reset the database

```bash
npm run db:seed               # ts-node prisma/seed.ts — users, orgs, events, bookings, tickets
npm run db:reset              # prisma migrate reset --force — DROP, re-migrate, then re-seed
```

`db:reset` is destructive (drops the schema). Seed accounts use password
`Password123!` on `@eticketsgo.test` (see the Developer Handbook).

## Regenerate the Prisma client

```bash
# stop API + worker first (Windows engine lock)
npm run db:generate           # prisma generate
```

Run after editing `schema.prisma` or after a fresh `npm install` if the client
looks stale (type errors referencing missing models).

## Rebuild + restart a single app

```bash
npm run build -w @eticketsgo/api            # or customer-web / organizer-web / admin-web / worker
npm run dev   -w @eticketsgo/<app>          # restart it
```

If you rebuilt a **shared package**, rebuild it first and restart the consumers:

```bash
npm run packages:build
# then restart the running *-web apps (see next recipe)
```

## Recover from the stale-frontend blank-page issue

Symptom (Windows especially): after rebuilding a shared package or an app, a
frontend serves **old JS chunks** and pages render blank / throw chunk-load errors.

1. Stop the affected `*-web` process (`Ctrl+C`).
2. If a shared package changed, `npm run packages:build`.
3. (If it persists) remove the app's stale build output, e.g.
   `rm -rf apps/customer-web/.next`.
4. Restart the app: `npm run dev -w @eticketsgo/customer-web`.
5. Hard-refresh the browser (Ctrl+F5) to drop cached chunks.

Root cause: a running `next start`/dev server keeps serving compiled chunks from
before the rebuild. Restarting the frontend after any rebuild avoids it.

## Inspect the worker jobs (hold expiry + notification dispatch)

The worker (`apps/worker/src/main.ts`) registers two BullMQ **repeatable** jobs on
the `holds` queue:

| Job                      | Default interval | Env override                     | Action                                                                          |
| ------------------------ | ---------------- | -------------------------------- | ------------------------------------------------------------------------------- |
| `expire-holds`           | 60 000 ms        | `HOLD_EXPIRY_INTERVAL_MS`        | `BookingsService.releaseExpiredHolds()` + `EventsService.completePastEvents()`. |
| `dispatch-notifications` | 30 000 ms        | `NOTIFICATION_SWEEP_INTERVAL_MS` | `NotificationService.dispatchDue()` — deliver due SCHEDULED rows, retry ≤3.     |

- Both jobs are **idempotent** (releasing an already-released hold / dispatching an
  already-sent row is a no-op) and retried up to 3× with exponential backoff.
- On boot the worker runs one immediate hold-expiry + past-event sweep so restarts
  clear any backlog.
- Structured JSON logs go to stdout (`service:"worker"`). Watch the worker terminal;
  it only logs when a sweep actually did work (`released`, `completed`,
  `dispatched scheduled notifications`).
- Health: `curl http://localhost:4100/health` (liveness),
  `curl http://localhost:4100/ready` (Postgres + Redis).
- Note: hold expiry also runs **lazily** inside `BookingsService.create` for the
  session being booked, so the customer flow is correct even if the worker is down.

## Feature-flag toggles

Flags resolve from `packages/shared-types/src/features.ts` with env overrides.

```bash
# enable an enterprise capability for a dev session
FEATURE_AI_RECOMMENDATIONS=1 npm run dev -w @eticketsgo/api
# turn a shipped feature off
FEATURE_COMMUNITY=false npm run dev -w @eticketsgo/api
```

- Env key = `FEATURE_<UPPER_SNAKE>` (or `NEXT_PUBLIC_FEATURE_<…>` for web); truthy
  values `1` / `true`. Key names: see the Developer Handbook §3.
- Check resolved state: `curl http://localhost:4000/api/capabilities`.
- Enterprise flags (`memberships`, `organizerCrm`, `sponsors`, …) default **off**
  and only surface as placeholders on the organizer Premium & enterprise page.

## Health / readiness probes

| Probe              | Meaning                                                                        |
| ------------------ | ------------------------------------------------------------------------------ |
| `GET /api/health`  | API liveness (`{ status: "ok", uptime }`).                                     |
| `GET /api/ready`   | API readiness — checks Postgres + Redis; `degraded` + `503` if either is down. |
| `GET :4100/health` | Worker liveness.                                                               |
| `GET :4100/ready`  | Worker readiness — Postgres + Redis.                                           |

## Toggle mock payments

The mock "simulate payment" path (`POST /api/payments/:bookingId/mock-pay`) is
allowed unless `PAYMENTS_MOCK_ENABLED=false` **or** `NODE_ENV=production`. Leave it
enabled in dev; set `PAYMENTS_MOCK_ENABLED=false` (or run as production) to force
the signed-webhook path only.

---

## Planned — not yet built

These are **not** implemented; documented so their absence is a decision, not a
surprise. Tracked for the Operations sprint.

- **Real production deploy** (containerized apps, staged rollout). CI
  (`.github/workflows/ci.yml`) currently installs, format-checks, lints,
  type-checks, migrates + seeds, unit-tests, builds, and runs Playwright — it does
  not deploy.
- **Backup / restore automation** for Postgres and Redis.
- **Real payment provider** (Stripe/Razorpay) behind the existing
  `PaymentProvider` interface — today only the mock provider exists.
- **Real notification delivery** (SendGrid/Twilio/FCM) behind the
  `NotificationChannel` stubs — channels are log-only today.
- **S3/MinIO storage** — the storage abstraction defaults to a local driver.
- **AI model bindings** behind the `ai.ports.ts` ports — Noop implementations only.
- **Admin fee-rule write endpoint** (`PATCH /admin/fee-rules/:id`) — the admin UI
  displays seeded `FeeRule`s read-only.
