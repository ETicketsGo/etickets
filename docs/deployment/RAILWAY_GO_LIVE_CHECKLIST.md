# ETicketsGo — Railway Go-Live Verification Checklist

> Run this against **each environment** after its first deploy, and against **Production**
> before every release. Setup steps live in the
> [Railway Deployment Runbook](./RAILWAY_DEPLOYMENT_RUNBOOK.md).

**How to use.** Record PASS / FAIL / N-A with evidence (a command's output, a screenshot, a
booking reference). A FAIL on anything marked **BLOCKER** stops the release. "N-A" is a
legitimate answer for a capability the environment does not use — but write down why.

```
Environment: ____________   Release/commit: ____________
Date: ____________          Verified by: ____________
```

Set `BASE` before running the commands:

```bash
BASE=https://api.eticketsgo.com          # or api-qa. / api-uat.
WEB=https://eticketsgo.com               # or qa. / uat.
```

---

## 1. DNS

| #   | Check                                                          | Command / method                                | BLOCKER | Result |
| --- | -------------------------------------------------------------- | ----------------------------------------------- | :-----: | ------ |
| 1.1 | Customer hostname resolves                                     | `dig +short $WEB`                               |   ✅    |        |
| 1.2 | API hostname resolves                                          | `dig +short api.eticketsgo.com`                 |   ✅    |        |
| 1.3 | Organizer hostname resolves                                    | `dig +short organizer.eticketsgo.com`           |   ✅    |        |
| 1.4 | Admin hostname resolves                                        | `dig +short admin.eticketsgo.com`               |   ✅    |        |
| 1.5 | `www` redirects to apex (production)                           | `curl -sI https://www.eticketsgo.com` → 301/308 |         |        |
| 1.6 | Worker has **no** public hostname                              | Railway → `worker` → Networking shows no domain |   ✅    |        |
| 1.7 | No environment's hostname resolves to another's Railway target | compare CNAME targets across the three projects |   ✅    |        |

## 2. SSL / TLS

| #   | Check                                    | Command / method                                              | BLOCKER | Result |
| --- | ---------------------------------------- | ------------------------------------------------------------- | :-----: | ------ |
| 2.1 | Valid certificate on every hostname      | `curl -sI $WEB` succeeds without `--insecure`                 |   ✅    |        |
| 2.2 | HTTP redirects to HTTPS                  | `curl -sI http://eticketsgo.com` → 301                        |   ✅    |        |
| 2.3 | Cloudflare SSL mode is **Full (strict)** | Cloudflare → SSL/TLS → Overview                               |   ✅    |        |
| 2.4 | HSTS header present                      | `curl -sI $WEB \| grep -i strict-transport`                   |         |        |
| 2.5 | Security headers present                 | `curl -sI $WEB \| grep -iE 'x-frame-options\|x-content-type'` |         |        |

## 3. API health

| #   | Check                                           | Command                                                                                                          | BLOCKER | Result |
| --- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | :-----: | ------ |
| 3.1 | Liveness                                        | `curl -fsS $BASE/api/health` → `{"status":"ok",...}`                                                             |   ✅    |        |
| 3.2 | Readiness (DB + Redis)                          | `curl -fsS $BASE/api/ready` → `"status":"ok"`                                                                    |   ✅    |        |
| 3.3 | Metrics served                                  | `curl -fsS $BASE/api/metrics \| grep etg_`                                                                       |         |        |
| 3.4 | Readiness returns 503 when a dependency is down | verified by unit test; optionally confirm in QA by pausing Redis                                                 |         |        |
| 3.5 | **Swagger NOT public in production**            | `curl -so /dev/null -w '%{http_code}' $BASE/api/docs` → 404                                                      |   ✅    |        |
| 3.6 | Health endpoints leak nothing                   | inspect bodies: no stack trace, hostname, or connection string                                                   |   ✅    |        |
| 3.7 | CORS rejects an unknown origin                  | `curl -sI -H 'Origin: https://evil.example' $BASE/api/health` → no `access-control-allow-origin` for that origin |   ✅    |        |

## 4. Web application health

| #   | Check                          | Command                                                 | BLOCKER | Result |
| --- | ------------------------------ | ------------------------------------------------------- | :-----: | ------ |
| 4.1 | Customer web health route      | `curl -fsS $WEB/api/health` → `"app":"customer-web"`    |   ✅    |        |
| 4.2 | Organizer web health route     | `curl -fsS https://organizer.eticketsgo.com/api/health` |   ✅    |        |
| 4.3 | Admin web health route         | `curl -fsS https://admin.eticketsgo.com/api/health`     |   ✅    |        |
| 4.4 | Homepage renders               | load `$WEB` in a browser; no console errors             |   ✅    |        |
| 4.5 | Web talks to the **right** API | DevTools → Network → XHR host is this environment's API |   ✅    |        |
| 4.6 | Static assets load             | no 404s on `/_next/static/*`                            |         |        |

## 5. Database migrations

| #   | Check                              | Command                                                            | BLOCKER | Result |
| --- | ---------------------------------- | ------------------------------------------------------------------ | :-----: | ------ |
| 5.1 | All migrations applied             | `railway run --service api npx prisma migrate status` → up to date |   ✅    |        |
| 5.2 | No failed migration recorded       | same output shows no `failed` entry                                |   ✅    |        |
| 5.3 | Migration ran exactly once         | `api` deploy log shows one pre-deploy migration block              |   ✅    |        |
| 5.4 | Worker/web ran **no** migration    | their deploy logs contain no `prisma migrate`                      |   ✅    |        |
| 5.5 | No schema drift                    | `security.yml` → `migration-drift` job green on the release commit |   ✅    |        |
| 5.6 | Database is this environment's own | connection host differs across all three projects                  |   ✅    |        |

## 6. Redis

| #   | Check                                   | Command                                                                                     | BLOCKER | Result |
| --- | --------------------------------------- | ------------------------------------------------------------------------------------------- | :-----: | ------ |
| 6.1 | Reachable                               | `curl -fsS $BASE/api/ready` reports `"redis":"up"`                                          |   ✅    |        |
| 6.2 | Instance is this environment's own      | host differs across all three projects                                                      |   ✅    |        |
| 6.3 | Keys carry this environment's namespace | `railway run --service api redis-cli --scan --pattern 'etg:*' \| head` → only `etg:<env>:*` |   ✅    |        |
| 6.4 | **No foreign-environment keys**         | same scan shows no other `etg:<other-env>:*`                                                |   ✅    |        |

## 7. Queues

| #   | Check                                | Command                                                                                                    | BLOCKER | Result |
| --- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------- | :-----: | ------ |
| 7.1 | BullMQ prefix is env-scoped          | keys under `etg:<env>:bull:*`                                                                              |   ✅    |        |
| 7.2 | Repeatable jobs registered           | `GET /api/admin/ops/queues` as admin lists the schedule                                                    |   ✅    |        |
| 7.3 | Backlog is not growing unbounded     | `etg_queue_jobs` gauge in `/api/metrics` stable                                                            |         |        |
| 7.4 | Failed-job count is zero/expected    | `GET /api/admin/ops/queues/failed`                                                                         |         |        |
| 7.5 | Producers and consumers agree        | a hold created via the API is expired by the worker (see 7.6)                                              |   ✅    |        |
| 7.6 | **Cross-env consumption impossible** | with QA and Production both running, confirm a QA-enqueued job is never processed by the production worker |   ✅    |        |

## 8. Worker processing

| #   | Check                                                   | Command                                                             | BLOCKER | Result |
| --- | ------------------------------------------------------- | ------------------------------------------------------------------- | :-----: | ------ |
| 8.1 | Worker service is running                               | Railway → `worker` → status Active                                  |   ✅    |        |
| 8.2 | Boot log emitted                                        | logs contain `"msg":"worker started"`                               |   ✅    |        |
| 8.3 | Worker readiness passes                                 | `railway run --service worker wget -qO- localhost:$PORT/ready`      |   ✅    |        |
| 8.4 | **Worker connected to Redis** (the `NOAUTH` regression) | logs contain no `NOAUTH`/`WRONGPASS`; a hold actually expires       |   ✅    |        |
| 8.5 | Hold expiry works end to end                            | create a hold, wait past TTL, confirm inventory is released         |   ✅    |        |
| 8.6 | Graceful shutdown                                       | restart the service; logs show `"shutting down"` and no dropped job |         |        |

## 9. Scheduler execution

The schedule is BullMQ repeatable jobs inside `worker` — there is no separate service.

| #   | Job                                      | Evidence                                 | BLOCKER | Result |
| --- | ---------------------------------------- | ---------------------------------------- | :-----: | ------ |
| 9.1 | `expire-holds`                           | expired holds released after TTL         |   ✅    |        |
| 9.2 | `dispatch-notifications`                 | a scheduled notification is delivered    |         |        |
| 9.3 | `process-webhooks`                       | a provider webhook moves past `RECEIVED` |   ✅    |        |
| 9.4 | `outbox-dispatch` / `outbox-maintenance` | run without error (no-op while disabled) |         |        |
| 9.5 | `reconcile-finance`                      | daily job registered                     |         |        |
| 9.6 | `prune-tokens`                           | daily job registered                     |         |        |
| 9.7 | `inventory-sync-sweep`                   | registered (no-op while flags off)       |         |        |

## 10. Email

| #    | Check                                        | Method                                                  | BLOCKER | Result |
| ---- | -------------------------------------------- | ------------------------------------------------------- | :-----: | ------ |
| 10.1 | `EMAIL_PROVIDER` correct for the environment | QA/UAT may be `log`; production must be real at go-live | ✅ prod |        |
| 10.2 | Test email delivers                          | complete a booking; confirm the ticket email arrives    | ✅ prod |        |
| 10.3 | Sender domain is environment-appropriate     | QA/UAT must not send from the production sender         |   ✅    |        |
| 10.4 | SPF/DKIM pass                                | inspect received headers                                | ✅ prod |        |
| 10.5 | Provider key is environment-scoped           | QA/UAT never hold the production key                    |   ✅    |        |

## 11. Push notifications

| #    | Check                                             | Method                                      | BLOCKER | Result |
| ---- | ------------------------------------------------- | ------------------------------------------- | :-----: | ------ |
| 11.1 | `PUSH_PROVIDER` matches intent                    | `log` is a valid production answer today    |         |        |
| 11.2 | If FCM: separate Firebase project per environment | QA push cannot reach a real customer device |   ✅    |        |
| 11.3 | If VAPID: distinct key pair per environment       |                                             |   ✅    |        |

## 12. Object storage

**Not implemented in this codebase.** `STORAGE_DRIVER` is declared in config but no upload
or object-storage code path exists. Railway's filesystem is ephemeral.

| #    | Check                                                               | Method                                                                       | BLOCKER | Result |
| ---- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------- | :-----: | ------ |
| 12.1 | Confirm no feature writes durable files to disk                     | `grep -rn "writeFile\|UploadedFile\|FileInterceptor" apps/api/src` → no hits |   ✅    |        |
| 12.2 | If storage is added later: bucket is per-environment, versioning on |                                                                              |   ✅    |        |

## 13. Stripe validation

| #    | Check                                               | Method                                                | BLOCKER | Result |
| ---- | --------------------------------------------------- | ----------------------------------------------------- | :-----: | ------ |
| 13.1 | QA/UAT use `sk_test_`                               | boot succeeds; a live key is refused at startup       |   ✅    |        |
| 13.2 | **Production uses `sk_live_`**                      | boot succeeds; `sk_test_` is refused with no override |   ✅    |        |
| 13.3 | `PAYMENT_ALLOW_LIVE_KEYS_LOWER_ENV=false` in QA/UAT | Railway variables                                     |   ✅    |        |
| 13.4 | Webhook secret is environment-specific              | three distinct `whsec_` values                        |   ✅    |        |
| 13.5 | `STRIPE_WEBHOOK_SECRET != PAYMENT_WEBHOOK_SECRET`   | boot fails otherwise                                  |   ✅    |        |
| 13.6 | Success/cancel URLs point at this environment       | Railway variables                                     |   ✅    |        |
| 13.7 | `PAYMENT_LIVE_ENABLED` false until go-live approval |                                                       |   ✅    |        |

## 14. Razorpay validation

| #    | Check                                                     | Method                  | BLOCKER | Result |
| ---- | --------------------------------------------------------- | ----------------------- | :-----: | ------ |
| 14.1 | QA/UAT use `rzp_test_` with `RAZORPAY_MODE=test`          | boot enforces agreement |   ✅    |        |
| 14.2 | **Production uses `rzp_live_` with `RAZORPAY_MODE=live`** | boot enforces agreement |   ✅    |        |
| 14.3 | `RAZORPAY_WEBHOOK_SECRET != RAZORPAY_KEY_SECRET`          | boot fails otherwise    |   ✅    |        |
| 14.4 | Callback URL points at this environment                   |                         |   ✅    |        |
| 14.5 | `RAZORPAY_ROUTE_ENABLED=false` until Route KYC signed off |                         |   ✅    |        |

## 15. Webhook delivery

| #    | Check                                                        | Method                                             | BLOCKER | Result |
| ---- | ------------------------------------------------------------ | -------------------------------------------------- | :-----: | ------ |
| 15.1 | Stripe endpoint registered for **this** environment          | `$BASE/api/payments/webhook/stripe`                |   ✅    |        |
| 15.2 | Razorpay endpoint registered for **this** environment        | `$BASE/api/payments/webhook/razorpay`              |   ✅    |        |
| 15.3 | Endpoints are distinct per environment with distinct secrets | provider dashboards                                |   ✅    |        |
| 15.4 | A test event is accepted and verified                        | provider dashboard shows 2xx                       |   ✅    |        |
| 15.5 | An event with a **wrong signature is rejected**              | replay a QA-signed event at production → rejected  |   ✅    |        |
| 15.6 | Webhook paths bypass Cloudflare cache and Access             | Cloudflare rules                                   |   ✅    |        |
| 15.7 | Durable retry works                                          | a transiently-failed event is retried by the sweep |         |        |

## 16. Booking creation

| #    | Check                                           | Method                       | BLOCKER | Result |
| ---- | ----------------------------------------------- | ---------------------------- | :-----: | ------ |
| 16.1 | Browse and open an event                        | UI                           |   ✅    |        |
| 16.2 | Create a booking end to end                     | UI                           |   ✅    |        |
| 16.3 | Booking reference has the right shape           | `ETG-<COUNTRY>-<YEAR>-<SEQ>` |   ✅    |        |
| 16.4 | Inventory decrements correctly                  | compare before/after         |   ✅    |        |
| 16.5 | Payment recorded with correct minor-unit amount | admin console                |   ✅    |        |

## 17. Seat locking

| #    | Check                                      | Method                | BLOCKER | Result |
| ---- | ------------------------------------------ | --------------------- | :-----: | ------ |
| 17.1 | Selecting a seat holds it                  | UI                    |   ✅    |        |
| 17.2 | A second session cannot take the held seat | two browsers          |   ✅    |        |
| 17.3 | Hold expires and releases                  | wait past TTL         |   ✅    |        |
| 17.4 | Lock keys are env-namespaced               | `etg:<env>:invlock:*` |   ✅    |        |

## 18. Duplicate booking prevention

| #    | Check                                                   | Method                             | BLOCKER | Result |
| ---- | ------------------------------------------------------- | ---------------------------------- | :-----: | ------ |
| 18.1 | Same idempotency key returns the original booking       | repeat the request                 |   ✅    |        |
| 18.2 | Double-click on checkout creates **one** booking        | UI                                 |   ✅    |        |
| 18.3 | Concurrent requests for the last seat oversell **zero** | `scripts/loadtest/concurrency.mjs` |   ✅    |        |

## 19. Cancellation

| #    | Check                                   | Method       | BLOCKER | Result |
| ---- | --------------------------------------- | ------------ | :-----: | ------ |
| 19.1 | Customer can cancel where policy allows | UI           |   ✅    |        |
| 19.2 | Inventory is returned                   | before/after |   ✅    |        |
| 19.3 | Cancelled tickets stop validating       | QR scan      |   ✅    |        |

## 20. Refund behaviour

| #    | Check                                    | Method                                                                               | BLOCKER | Result |
| ---- | ---------------------------------------- | ------------------------------------------------------------------------------------ | :-----: | ------ |
| 20.1 | `BOOKING_REFUND_POLICY_MODE=MANUAL_ONLY` | Railway variables                                                                    |   ✅    |        |
| 20.2 | **No automatic refund executes**         | `BOOKING_COMPENSATION_AUTO_REFUND_ENABLED=false`; production refuses to boot if true |   ✅    |        |
| 20.3 | Manual refund path works                 | admin console                                                                        |   ✅    |        |
| 20.4 | Refund is idempotent                     | repeat the operation; one refund                                                     |   ✅    |        |

## 21. QR generation

| #    | Check                                              | Method     | BLOCKER | Result |
| ---- | -------------------------------------------------- | ---------- | :-----: | ------ |
| 21.1 | QR generated on confirmation                       | UI / email |   ✅    |        |
| 21.2 | Signed with this environment's `QR_SIGNING_SECRET` |            |   ✅    |        |
| 21.3 | Wallet pass generated if enabled                   |            |         |        |

## 22. QR validation

| #    | Check                                        | Method                 | BLOCKER | Result |
| ---- | -------------------------------------------- | ---------------------- | :-----: | ------ |
| 22.1 | Valid QR admits at check-in                  | check-in app           |   ✅    |        |
| 22.2 | Second scan is rejected (no double entry)    |                        |   ✅    |        |
| 22.3 | **A QA-issued QR is rejected in production** | cross-environment scan |   ✅    |        |
| 22.4 | Tampered QR rejected                         |                        |   ✅    |        |

## 23. Admin login

| #    | Check                                              | Method                              | BLOCKER | Result |
| ---- | -------------------------------------------------- | ----------------------------------- | :-----: | ------ |
| 23.1 | Admin can log in                                   | admin web                           |   ✅    |        |
| 23.2 | Admin console reachable behind Cloudflare Access   |                                     |   ✅    |        |
| 23.3 | **No seeded demo credential exists in production** | verify the seed was never run there |   ✅    |        |
| 23.4 | Wrong password is rejected and rate-limited        |                                     |   ✅    |        |

## 24. Organizer login

| #    | Check                                              | Method                      | BLOCKER | Result |
| ---- | -------------------------------------------------- | --------------------------- | :-----: | ------ |
| 24.1 | Organizer can log in                               | organizer web               |   ✅    |        |
| 24.2 | Sees only their own organization's data            | tenancy check               |   ✅    |        |
| 24.3 | Payout onboarding returns to the right environment | `STRIPE_CONNECT_RETURN_URL` |   ✅    |        |

## 25. Customer login

| #    | Check                            | Method                                 | BLOCKER | Result |
| ---- | -------------------------------- | -------------------------------------- | :-----: | ------ |
| 25.1 | Register and log in              | customer web                           |   ✅    |        |
| 25.2 | Token refresh works              | leave the session idle past access TTL |   ✅    |        |
| 25.3 | Logout revokes the refresh token |                                        |   ✅    |        |
| 25.4 | Password reset delivers          | requires working email                 | ✅ prod |        |

## 26. Guest booking

| #    | Check                                       | Method | BLOCKER | Result |
| ---- | ------------------------------------------- | ------ | :-----: | ------ |
| 26.1 | Book without an account                     | UI     |   ✅    |        |
| 26.2 | Guest receives ticket + QR by email         |        | ✅ prod |        |
| 26.3 | Guest can retrieve the booking by reference |        |   ✅    |        |

## 27. Logs

| #    | Check                                     | Method                                          | BLOCKER | Result |
| ---- | ----------------------------------------- | ----------------------------------------------- | :-----: | ------ |
| 27.1 | Logs visible per service                  | Railway → service → Logs                        |   ✅    |        |
| 27.2 | Structured JSON from the worker           |                                                 |         |        |
| 27.3 | Correlation IDs present on API requests   |                                                 |         |        |
| 27.4 | **No secret appears in any log**          | search logs for `sk_`, `whsec_`, `rzp_`, `JWT_` |   ✅    |        |
| 27.5 | **No full payment payload or PAN logged** |                                                 |   ✅    |        |
| 27.6 | Log history is per-project (not shared)   |                                                 |   ✅    |        |

## 28. Sentry

| #    | Check                                             | Method                                                | BLOCKER | Result |
| ---- | ------------------------------------------------- | ----------------------------------------------------- | :-----: | ------ |
| 28.1 | `SENTRY_DSN` set (production)                     |                                                       | ✅ prod |        |
| 28.2 | `SENTRY_ENVIRONMENT` matches the environment      | issues are separable                                  |   ✅    |        |
| 28.3 | `SENTRY_RELEASE` carries the git SHA              |                                                       |         |        |
| 28.4 | A deliberate test error arrives, tagged correctly |                                                       | ✅ prod |        |
| 28.5 | **No PII in the event** (scrubber active)         | inspect an event: no cookies, body, auth header, user |   ✅    |        |
| 28.6 | Worker errors reported with `service: worker`     |                                                       |         |        |

## 29. Backup verification

| #    | Check                                                                   | Method                       | BLOCKER | Result |
| ---- | ----------------------------------------------------------------------- | ---------------------------- | :-----: | ------ |
| 29.1 | Automated backups enabled on production Postgres                        | Railway → Postgres → Backups |   ✅    |        |
| 29.2 | Retention recorded in [Backup & Recovery](./RAILWAY_BACKUP_RECOVERY.md) |                              |   ✅    |        |
| 29.3 | A backup exists dated within the RPO                                    |                              |   ✅    |        |
| 29.4 | **Restore has been tested at least once** into a scratch database       |                              |   ✅    |        |
| 29.5 | RPO/RTO documented and agreed                                           |                              |   ✅    |        |
| 29.6 | Redis persistence expectation understood (not a source of truth)        |                              |         |        |

## 30. Rollback test

| #    | Check                                                              | Method                                        | BLOCKER | Result |
| ---- | ------------------------------------------------------------------ | --------------------------------------------- | :-----: | ------ |
| 30.1 | Previous deployments are listed and redeployable                   | Railway → Deployments                         |   ✅    |        |
| 30.2 | **Rollback rehearsed in QA or UAT**                                | redeploy the previous version; confirm health |   ✅    |        |
| 30.3 | Rollback order documented (web → worker → api)                     | runbook §17                                   |   ✅    |        |
| 30.4 | This release's migrations are additive (rollback-safe)             | review the migration SQL                      |   ✅    |        |
| 30.5 | If any migration is destructive: restore plan written and approved |                                               |   ✅    |        |

## 31. Environment isolation

The highest-value section. Every check here is about something in one environment being
unable to affect another.

| #     | Check                                                                                                           | Method                                        | BLOCKER | Result |
| ----- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | :-----: | ------ |
| 31.1  | Three separate Railway **projects** exist                                                                       | dashboard                                     |   ✅    |        |
| 31.2  | Separate PostgreSQL per environment                                                                             | different hosts                               |   ✅    |        |
| 31.3  | Separate Redis per environment                                                                                  | different hosts                               |   ✅    |        |
| 31.4  | `APP_ENV` distinct and correct in each                                                                          | ✅                                            |         |
| 31.5  | Redis keyspaces do not overlap                                                                                  | `etg:qa:*` / `etg:uat:*` / `etg:production:*` |   ✅    |        |
| 31.6  | All four core secrets differ across all three environments                                                      | JWT access/refresh, QR, payment webhook       |   ✅    |        |
| 31.7  | Payment credentials differ; production is the only live one                                                     | ✅                                            |         |
| 31.8  | Webhook endpoints and secrets differ                                                                            | provider dashboards                           |   ✅    |        |
| 31.9  | Domains differ and none cross-points                                                                            | ✅                                            |         |
| 31.10 | `CORS_ORIGINS` lists only this environment's origins                                                            | ✅                                            |         |
| 31.11 | Railway tokens are project-scoped, stored per GitHub Environment                                                | ✅                                            |         |
| 31.12 | QA/UAT protected by Cloudflare Access                                                                           | not publicly reachable                        |   ✅    |        |
| 31.13 | Email sender domains differ                                                                                     | ✅                                            |         |
| 31.14 | Push/Firebase projects differ (if enabled)                                                                      | ✅                                            |         |
| 31.15 | Sentry environments differ                                                                                      | ✅                                            |         |
| 31.16 | **Production shares nothing with QA/UAT** — database, Redis, queue, bucket, secret, webhook, payment credential | final review of 31.2–31.15                    |   ✅    |        |

---

## Sign-off

| Role                           | Name | Date | Verdict (GO / NO-GO) |
| ------------------------------ | ---- | ---- | -------------------- |
| Release engineer               |      |      |                      |
| Engineering owner              |      |      |                      |
| Finance (production, money on) |      |      |                      |

**Blocking failures:**

```

```

**Accepted risks (with owner and expiry):**

```

```
