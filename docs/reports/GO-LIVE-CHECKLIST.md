# ETicketsGo — Go-Live Checklist (cutover)

Ordered runbook for the production cutover. Assumes managed Postgres + Redis are provisioned.

## T-1 day

1. Freeze mainline; tag the release (`v1.0.0`).
2. Provision infra: Postgres (with PITR backups), Redis, app hosts for API + worker + 3 web apps.
3. Configure secrets/env per app: `DATABASE_URL`, `REDIS_URL`, JWT access/refresh secrets, `PAYMENT_WEBHOOK_SECRET`, `CORS_ORIGINS`, `NODE_ENV=production`, `PAYMENTS_MOCK_ENABLED=false`, `FEATURE_*` (enterprise flags off), `NEXT_PUBLIC_API_URL`.
4. Bind a real payment provider behind the existing `PaymentProvider` interface + point its webhook at `/api/payments/webhook`.
5. Bind real notification providers (SendGrid/Twilio/FCM) behind the channel stubs, or accept log-only for launch.

## T-0 cutover

6. Run DB migrations: `npm run db:deploy` (applies additive migrations forward). **Do NOT seed.**
7. Deploy API, then worker, then the three web apps (build already verified in CI).
8. **Smoke tests (must pass):**
   - `GET /api/health` → 200; `GET /api/ready` → 200; `GET /api/metrics` → 200 (then restrict to scraper).
   - Register a throwaway customer → browse → book a free/test event → pay (real provider sandbox) → QR ticket issued.
   - Movie: pick a seeded/real show → select seat → book → confirm → seat-bound ticket; verify the seat flips to SOLD.
   - Organizer login → create + submit an event; Admin login → approve.
   - Refund a test booking → verify seat/stock returns.
9. Verify metrics counters increment (`etg_bookings_*`, `etg_checkins_total`) and JSON logs flow to the aggregator.
10. Enable monitoring/alerts (payment-failure rate, 5xx rate, booking-confirm errors).

## Post-launch (first 48h)

11. Watch dashboards; keep the rollback plan ready (redeploy previous tag; migrations are additive/forward-compatible so no down-migration needed).
12. Confirm scheduled worker jobs run (hold expiry, notification dispatch).

## Rollback

- App: redeploy the previous release tag (additive migrations remain compatible).
- Data: restore from PITR only for data corruption (see DISASTER-RECOVERY).
