# Railway Infrastructure as Code

`railway.ts` describes the six ETicketsGo app services in QA, UAT and PROD (named partial
`apps`; Postgres and Redis are deliberately not managed here). `variables.ts` is GENERATED:
variable names only, every one `preserve()`d.

Read `docs/deployment/RAILWAY-IAC-MIGRATION.md` before running `railway config plan` or
`apply`. In short:

- A project token is scoped to one environment; plan/apply act on that environment only.
- `apply` deploys every changed service at the head of `main`, all at once.
- Never `--confirm-destructive` without the owner approving that exact plan.
- `npm run verify:deploy` compiles this file for all three environments in CI.
- `scripts/deploy/railway-iac-preview.mjs` compares it, read-only, with what an environment runs.
