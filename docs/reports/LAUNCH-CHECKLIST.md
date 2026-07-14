# ETicketsGo — Launch Checklist (pre-production)

Every item verified at HEAD `feat/eticketsgo-platform` unless marked ☐ (action required before prod).

## Engineering quality gate — ✅ all green

- [x] Lint (ESLint, all packages)
- [x] Format (Prettier)
- [x] Typecheck 16/16 tasks
- [x] Unit tests 194/194 (33 suites)
- [x] Circular-dependency gate (`madge`) — none
- [x] Build 8/8 (all apps + packages)
- [x] Playwright e2e 4/4 (GA booking, movie seat booking, organizer wizard, admin review)
- [x] Migrations additive / backward compatible (no destructive DDL)

## Architecture — ✅

- [x] Bounded contexts + acyclic dependency direction
- [x] Pluggable seams (Inventory, Pricing, Notification, Discovery, Recommendation, AI ports)
- [x] Atomic money/inventory transitions (verified live)
- [x] 24 ADRs + Architecture Handbook + context/dependency/sequence diagrams

## Security — ✅ (see SECURITY-REPORT)

- [x] JWT access + rotating refresh with **reuse detection**
- [x] RBAC + multi-tenant isolation (tested)
- [x] Auth-endpoint rate limiting; global throttling; helmet + allow-listed CORS
- [x] Parameterized SQL (Prisma incl. seat-lock `Prisma.join`); webhook HMAC (timingSafeEqual)
- [x] bcrypt cost 12; no secrets committed
- [ ] **Prod:** move refresh token to HttpOnly cookie (D6); set `trust proxy`; restrict `/metrics` to scraper; bind a real payment provider & disable mock (`PAYMENTS_MOCK_ENABLED=false`)

## Performance — ✅ (see PERFORMANCE-REPORT)

- [x] Hot-path indexes; organizer-dashboard N+1 removed; atomic set-based holds; discovery/catalog cache
- [ ] **Prod:** load test the seat-hold path at target concurrency

## Operations — ✅/☐ (see OPERATIONS)

- [x] `/api/health`, `/api/ready`, `/api/metrics`; structured JSON logs; worker sweeps
- [ ] **Prod:** Prometheus scrape + Grafana board; log aggregation; Sentry; managed-Postgres PITR backups; alerting rules

## Data & config — ☐ prod

- [ ] Provision managed Postgres + Redis; run `prisma migrate deploy`
- [ ] Set env (JWT secrets, `PAYMENT_WEBHOOK_SECRET`, CORS origins, `FEATURE_*`, `NODE_ENV=production`)
- [ ] Do NOT run seed in production

## Accessibility & UX — ✅ (see UX-REVIEW)

- [x] Loading/empty/error/success states, focus rings, dialog focus trap, seat colour-not-alone, keyboard nav
