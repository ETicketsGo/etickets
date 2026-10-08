# Redis-backed rate limits: QA activation and rollback

**Scope: QA only.** Production keeps `THROTTLE_STORAGE` unset (in-memory). Turning it on in
production is a separate owner decision, taken after this procedure passes on QA.

**Status: not performed.** It changes an environment variable, so it needs owner approval.

## Preconditions

1. **QA runs code that contains #216.** Today QA's API is on `08a476d`, which does not.
   Deploying current `main` to QA also deploys the venue/space migrations, so the QA location
   audit (`docs/product/QA-PRE-DEPLOY-LOCATION-AUDIT.md`) must pass section A first.
2. **QA's API reaches Redis.** `GET https://<qa-api>/api/ready` returns `checks.redis: "up"`.
   Redis is already used by BullMQ, so `REDIS_URL` is already set; don't change it.
3. **You know QA's auth limit.** `AUTH_THROTTLE_LIMIT` is 10 per minute per IP unless QA
   overrides it. Call the effective value **N**. Read that one variable; don't dump the others.
4. **Use a dedicated test account** with a known **wrong** password. Never use a real customer.
5. **Tell anyone running QA e2e suites first.** The limit counts requests per IP, and this
   procedure deliberately trips it.

## Activate

1. On the QA **api** service only, set `THROTTLE_STORAGE=redis`. Don't touch the worker or
   production.
2. Restart or redeploy the QA api, and wait for `/api/ready` to report both checks `up`.
3. Check the logs: the line `Rate-limit counters have fallen back to per-process memory` must
   **not** appear.

## Verify

Send each request from one machine (one IP).
`POST /api/auth/login` with the test email and the wrong password.

| Check                                                                                            | Steps                                                                                                            | Pass                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Connectivity**                                                                                 | Send 1 request. In a Redis shell on QA: `SCAN 0 MATCH etg:qa:throttle:* COUNT 1000`, then `PTTL` one of the keys | Keys exist under `etg:qa:throttle:`. `PTTL` is **≤ 60000** ms                                                                                                                                                                                                                    |
| **Lockout**                                                                                      | Send N+1 requests within a minute                                                                                | Requests 1..N return 401. Request N+1 returns **429**                                                                                                                                                                                                                            |
| **Lockout expiry**                                                                               | Wait 65 s after the 429, then send 1 request                                                                     | **401**, not 429. The block lasts about a minute, not hours (the pre-fix defect was 16.7 h)                                                                                                                                                                                      |
| **Restart persistence**                                                                          | Trip the limit again (429). Restart the QA api. As soon as `/api/ready` is up, send 1 request                    | **429**: the counter survived the restart. In-memory storage would return 401. Then wait 65 s: 401                                                                                                                                                                               |
| **Failure behaviour** _(optional; needs owner approval because it also stops BullMQ jobs on QA)_ | Stop QA Redis for at most 2 minutes. Log in correctly once, then send N+1 wrong-password requests                | Correct logins still succeed (no outage). Request N+1 still returns 429 from the per-process fallback. Exactly **one** WARN `fallen back to per-process memory`. Each request waits at most `REDIS_COMMAND_TIMEOUT_MS` (1 s) extra. After Redis restarts, one LOG `shared again` |

Redis is unavailable → the limit falls back to **per-process memory**. That is neither fail-open
(no limit) nor fail-closed (refusing logins). Commands are rejected within 1 s and are never
queued, so requests don't hang.

## Roll back

1. On the QA api, remove `THROTTLE_STORAGE`, or set it to `memory`.
2. Restart the QA api. Counters return to in-memory, per process.
3. Leftover `etg:qa:throttle:*` keys expire by themselves within one window or block (about
   60 s). **Never `FLUSHDB`**: QA Redis also holds the BullMQ queues and operational flags.

## Record

Write down the date, QA's api commit, N, and pass or fail for each row, in the deployment
ticket. Include no credentials and no Redis URL.
