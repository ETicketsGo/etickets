# Database protection

What stops an accident from costing data, what is automatic, and the few things only an account
owner can do.

Written after a QA environment was emptied by a deployment nobody intended as destructive.

---

## What happened, in one paragraph

A service (`db-seed`) whose default action was to delete every row got deployed. The start
command had been changed through the Railway API to something harmless, and the API accepted
it — but `deploy/railway/db-seed.railway.json` is config-as-code and silently overrides the
API, so the old destructive command ran. It then died partway through, on a foreign key that a
hand-maintained deletion list had never been updated for, leaving the database emptied and
unable to reseed itself. There were no backups.

Four things had to be true at once. All four were.

---

## What is automatic now

| Protection                         | Where it lives                                           |
| ---------------------------------- | -------------------------------------------------------- |
| Nightly verified backup, 02:00     | `cronSchedule` in `deploy/railway/db-seed.railway.json`  |
| Backup before any destructive run  | `prisma/seed-operation.ts` — aborts if it fails          |
| Every dump read back after writing | `prisma/backup.ts` — unverified dumps are deleted        |
| Production can never be reset      | `prisma/destructive-guard.ts` — allowlist                |
| Retention: 14 recovery points      | `prisma/backup.ts`, pruned only after a new one verifies |
| Five build-failing gates           | `npm run verify:deploy`                                  |

None of it depends on anyone remembering.

---

## The guard

`apps/api/prisma/destructive-guard.ts` decides whether a process may empty a database. It is an
**allowlist** — `LOCAL, DEV, TEST, CI, QA, UAT` — not a "refuse if production" check.

That distinction is the whole design. "Refuse if production" fails the moment the environment
cannot be identified: an unset `APP_ENV`, a typo, a new environment nobody listed, all read as
"not production". An allowlist refuses anything it does not recognise.

- **`PRODUCTION` and `STAGING` cannot be added through configuration.** Only by editing the
  allowlist, in a commit, with a reviewer — and the build fails if they appear there.
- **Not `NODE_ENV`.** QA and UAT both run `NODE_ENV=production`, because they are production
  builds. A guard keyed on it would refuse to reset QA while reporting that it had protected
  production.
- **It runs before anything connects.** The check happens before `require('./seed')`, which
  constructs a Prisma client on load. A guard inside the seed has already opened a connection
  to the database it is deciding whether to destroy.
- **It calls `process.exit`, not `throw`.** A thrown error can be caught by a well-meaning
  wrapper and downgraded to a warning.
- **Disagreement is refused.** If `APP_ENV` says QA and the platform reports production,
  neither is believed.

---

## Operations

Run through the seed service, inside the private network. Postgres is not reachable from
outside and must stay that way.

```
node scripts/deploy/run-seed-operation.mjs status          # read-only census + environment identity
node scripts/deploy/run-seed-operation.mjs backups         # list recovery points
node scripts/deploy/run-seed-operation.mjs backup          # take one now
node scripts/deploy/run-seed-operation.mjs restore-drill   # prove the newest one restores
node scripts/deploy/run-seed-operation.mjs india-cinema    # regulatory policies, additive
node scripts/deploy/run-seed-operation.mjs full-reset --yes-empty-the-database
```

`full-reset` takes a verified recovery point first and **aborts if it cannot**. There is no
flag to skip that.

> **Never change a service's start command through the Railway API or dashboard.** Config-as-code
> wins, the API will tell you it worked, and what runs is whatever the repository says. Change
> the file, commit it, deploy.

---

## Restoring

```
# 1. What can we restore to?
node scripts/deploy/run-seed-operation.mjs backups

# 2. Does the newest one actually restore? (safe — scratch database, dropped afterwards)
node scripts/deploy/run-seed-operation.mjs restore-drill
```

To restore for real, from inside the network:

```
pg_restore --clean --if-exists --no-owner --no-acl --dbname "$DATABASE_URL" /backups/<file>.dump
```

Take a fresh backup **before** restoring an old one. The current state may be wrong, but it is
still the only copy of anything that happened since the backup was taken.

---

## Auditing a live environment

The build gate proves the repository is safe. It cannot see what an environment is actually
configured to do — and the incident was a deployment property, not a code property.

```
RAILWAY_TOKEN=<environment token> node scripts/ops/database-safety-audit.mjs
```

It checks: `APP_ENV` set on every service, Postgres not publicly exposed, what deploying
`db-seed` would actually do, no authorisation variables left lying around, restart policy
`NEVER`, and whether any backup exists. Read-only, prints no credential, exits non-zero on a
failure.

**Run it against production before launch, and after any infrastructure change.**

---

## Setting up production

Do these in order. Steps 1–5 are required before the first customer transaction.

1. **`APP_ENV=PRODUCTION`** on every service. Without it the guard cannot identify the
   environment — which is safe (nothing destructive can run) but also means nothing else can
   tell where it is either.
2. **No `db-seed` service in production at all.** It exists to run destructive and
   configuration operations. Production needs neither, and the safest version of a dangerous
   tool is its absence. If one exists for backups, it must have `SEED_DEFAULT_OPERATION=backup`
   and never `SEED_ALLOW_DESTRUCTIVE`.
3. **No public TCP proxy on Postgres.** The audit checks this.
4. **Enable Railway's own daily volume backups** on the Postgres volume, in the dashboard.
   **This is the one thing no automation here can do** — `volumeInstanceBackupCreate` and
   `volumeInstanceBackupScheduleUpdate` both return `Not Authorized` to a project-scoped token,
   which is what deployments use. Belt and braces with the pg_dump recovery points: they protect
   against different failures — a volume snapshot survives a corrupted database, a logical dump
   survives a corrupted volume.
5. **A backup volume** mounted at `/backups`, and `RAILWAY_RUN_UID=0` on that service only
   (Railway mounts volumes as root; the API image otherwise runs unprivileged, and must
   continue to).
6. **Run the audit.** It should report no failures.
7. **Run a restore drill.** A backup nobody has restored is a belief, not a recovery point.

### Owner-only actions, collected

Everything else is automatic. These need a human with account-level access:

- Enable Railway daily volume backups on each Postgres volume (QA, UAT, Production).
- Confirm no `db-seed` service exists in production, or that it carries no destructive
  authorisation.
- Schedule a quarterly restore drill and record the result.

---

## What the build will refuse

`npm run verify:deploy` fails if:

- a Railway service runs `prisma/seed.ts` or `npm run db:seed` directly
- `PRODUCTION`, `PROD` or `STAGING` appears in the destructive allowlist
- a seed script stops calling `assertDestructiveResetAllowed()`
- the `full-reset` path stops taking a recovery point
- an npm script calls `prisma migrate reset` directly
- `db-seed` loses its backup schedule, or its restart policy stops being `NEVER`
- `full-reset` becomes selectable as a scheduled default

Each of these was verified by reintroducing the fault and watching the build fail.
