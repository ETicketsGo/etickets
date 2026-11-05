# Production deploy of `e6d751e1`: steps for the owner (2026-10-26)

The engineering tool refused the production deploy ("Production Deploy" safety check), even with the owner's
conditional approval in chat. It was not worked around. Scope, migrations and rollback:
`PROD-RELEASE-REQUEST-2026-10-26.md`.

## Gates already passed (2026-10-26, 11:00-11:20 UTC)

| Gate            | Evidence                                                                                                                                                                                                                                                                                           |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exact changes   | `2439e254..e6d751e1`: 20 merges (#461-#495). API areas: notifications, auth, support, users, organizations, human-check, tenancy, discovery, config, observability, ops, admin, one check-in test file. **No change** under payments, bookings, refunds, payouts, settlements, finance or pricing. |
| Migrations      | 4 new, 0 edited. All additive: nullable columns, new tables, enum values, a reference trigger plus a backfill that fills only the new `Feedback.reference` column. The running PROD code ignores all of it. Applied on QA without error.                                                           |
| Fresh backup    | `etg-production-predeploy-2026-10-26T11-06-35Z.dump`, sha256 `48c3f94e0fc8eae8...`. Restore drill matched live on all 111 tables, payment sum 820182 minor units and 133 migrations. Off-Railway copy in `~/etg-prod-backups`, same hash.                                                          |
| Rollback points | Running state equals the release request: api `ab71fb7e`, worker `a2566b03`, admin-web `da92a8ac`, organizer-web `d2cd0146`, customer-web `7305672b`.                                                                                                                                              |
| Triggers        | Auto-deploy off and no triggers on every PROD service, so nothing deploys by itself.                                                                                                                                                                                                               |
| QA              | QA has run `e6d751e1` since 09:11 UTC. Organizer cert 13/13 + 44/44; Moto G31 console walk 9/9; regression 11/11 (sign-in, quote, hold, Razorpay TEST order, idempotency, release, refunds, India SMS refused, support reference).                                                                 |
| Config          | No new required variable. The organizer console derives the storefront from its hostname (no fixed value in the published bundle), so the `www.` fix applies.                                                                                                                                      |

If you start later than about 2 hours after the backup, run the backup again first (step 1).

## Option A: let the engineering tool run it

Add this to `.claude/settings.local.json` in the repo, in `permissions.allow`. Then ask it to deploy:

```
"Bash(CONFIRM_PROD_DEPLOY=*)",
"Bash(CONFIRM_PROD_VARIABLE=*)"
```

The safety check may still refuse. If it does, use option B.

## Option B: run it yourself

Use Git Bash, from the repo checkout. The token is the `PROD:` line of `Railway_Token.txt`. Never paste it into chat.

```
cd C:/Users/srini/OneDrive/Documents/etickets
export RAILWAY_TOKEN="$(grep -i '^PROD:' /c/Users/srini/OneDrive/Documents/Railway_Token.txt | sed 's/^[^:]*:[[:space:]]*//' | tr -d '\r\n')"
K=C:/etg-wt/prod-deploy-kit
SHA=e6d751e1bbf59a4c25a8dbf54ecdd9e3a40798ce   # = git rev-parse e6d751e1

# 1. Only if the backup above is older than ~2 hours:
ssh -i ~/.ssh/rlwaysshkey 9b2990a6-e7c4-4697-8ba2-5bdb1feee899@ssh.railway.com 'BACKUP_LABEL=production sh -s' < $K/predeploy-backup.sh | tail -4
#    Continue ONLY on "RESULT: restored copy matches live on every table".

# 2. Official links in emails (no deploy is triggered; the next deploy picks them up).
printf 'https://www.eticketsgo.com' > /tmp/cw; printf 'https://organizer.eticketsgo.com' > /tmp/ow; printf 'https://admin.eticketsgo.com' > /tmp/aw
for s in api worker; do
  CONFIRM_PROD_VARIABLE=$s:CUSTOMER_WEB_URL  node $K/set-var.mjs PROD $s CUSTOMER_WEB_URL  --from-file /tmp/cw
  CONFIRM_PROD_VARIABLE=$s:ORGANIZER_WEB_URL node $K/set-var.mjs PROD $s ORGANIZER_WEB_URL --from-file /tmp/ow
  CONFIRM_PROD_VARIABLE=$s:ADMIN_WEB_URL     node $K/set-var.mjs PROD $s ADMIN_WEB_URL     --from-file /tmp/aw
done

# 3. Deploys, in this order, each waiting for SUCCESS. The api runs the 4 migrations.
for s in api worker customer-web organizer-web admin-web; do
  CONFIRM_PROD_DEPLOY=$s@$SHA node $K/deploy-pinned.mjs PROD $s $SHA || break
done
node $K/state.mjs PROD
```

Stop at the first failure and tell the engineering tool. It will read the logs (`logs.mjs`) and roll back if needed.

## After the deploy: the engineering tool verifies (read-only, plus one support message)

- `state.mjs PROD`: all five services on `e6d751e1`. `_prisma_migrations` lists the four new names, none failed.
- `/api/health` and `/api/ready` return 200.
- The console login page links to `https://www.eticketsgo.com/register?intent=organizer`, and that page returns 200 (the 404 is gone).
- Your real login, and a one-click handoff to the console for an organizer account you own.
- Roles: a non-member is refused a handoff (403); admin requires MFA.
- `POST /api/support` returns `ETG-SUP-2026-...`. Email links use the official hosts.
- Privacy consent version v2 is shown. Capabilities are unchanged: sales restrictions as they are, phone sign-in US/CA, human check off.
- Existing bookings still readable with their references. No booking, payment or payout row changed (counts before and after).

Ticket sales stay as they are; nothing in this release enables them.

## Rollback

`CONFIRM_PROD_ROLLBACK=<service>@<full deployment id> node $K/rollback.mjs PROD <service> <full deployment id> <commit prefix>`, with the full ids in `PROD-RELEASE-REQUEST-2026-10-26.md` section 1 (commit `2439e254`, or `62d6d453` for customer-web). The migrations stay in
place; every one is compatible with the old code.
