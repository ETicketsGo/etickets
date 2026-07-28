# Merge-Readiness Report — Payment + Platform Normalization

**Date:** 2026-07-28 · **Author:** Release Engineering · **Repo:** `ETicketsGo/etickets` (private)

## 1. Repository state (audited, not assumed)

| Ref                                                  | SHA       | Notes                               |
| ---------------------------------------------------- | --------- | ----------------------------------- |
| `main` == `origin/main`                              | `d8de6ff` | PR #18 (v2.1 audit) merged; in sync |
| `feat/stripe-connect-us` (payment tip)               | `fbce16a` | **local only — not on origin**      |
| `feat/inventory-sourcing-platform` (fdn tip)         | `8b4bf36` | **local only — not on origin**      |
| `feat/provider-neutral-booking-orchestration` (HEAD) | `fb31e90` | **local only — not on origin**      |

- **`gh` auth:** `deeptricsllc`, scopes `repo`+`workflow`.
- **Branch protection on `main`:** none enforced (private repo, free plan → API 403). CI
  (`.github/workflows/ci.yml`, `deploy.yml`) runs on push/PR.
- **Existing PRs:** #19 (production-launch docs) and #20 (customer-mobile) are **unrelated**.
  **No payment PR and no platform PR exist.**
- **Working tree:** clean. **Unpushed commits:** all 118 in `main..HEAD` (none of the three
  stacked branches are on origin). **Untracked files:** none.

## 2. Commit graph — linear, zero merge commits

```
main (d8de6ff)
  │  13 commits  ── PAYMENT track
  ▼
feat/stripe-connect-us (fbce16a)
  │  46 commits  ── PLATFORM foundation (inventory sourcing, event bus, outbox, Redis locks, sync)
  ▼
feat/inventory-sourcing-platform (8b4bf36)
  │  59 commits  ── BOOKING orchestration + P5.3 compensation/void/refund + P6 docs
  ▼
HEAD feat/provider-neutral-booking-orchestration (fb31e90)
```

`git rev-list --merges main..HEAD` = **0**. Payments ⊂ platform ⊂ booking (each is a strict
ancestor). `merge-base(main,HEAD) = d8de6ff`.

### Exact commit ranges

1. **Payment (13):** `d8de6ff..fbce16a` — `8904815 M1 … fbce16a Razorpay docs` (Stripe Connect M1–M9 + Razorpay A–H).
2. **Platform foundation (46):** `fbce16a..8b4bf36` — inventory sourcing, domain event bus, transactional outbox, distributed Redis locking, external inventory sync, readiness review.
3. **Booking orchestration + P5.3 + P6 docs (59):** `8b4bf36..fb31e90` — orchestration flows, compensation foundation, provider reservation cancel, controlled void, **controlled full refund (Phase 6)**, and the doc-only closure commits (`46837c5`, `fb31e90`).
   - _No separate "P6 documentation-only" range exists yet_ — the only P6 docs so far are the two closure reports committed inside this range (`fb31e90`). P6 hardening work begins on a new branch (Stage B).

## 3. Can payments merge without duplication?

**Yes — cleanly.** The 13 payment commits are a strict ancestor prefix of the stack and are
**not yet on origin**, so there is currently zero duplication risk. The safe sequence (owner-chosen:
_payment-first, preserve SHAs_):

1. Push `feat/stripe-connect-us`; open **Payment PR** (base `main` ← head `feat/stripe-connect-us`).
2. Merge it **preserving SHAs** — "Create a merge commit" (or a local `--ff-only`, since `main` is a
   strict ancestor of `fbce16a`). **Do NOT squash** — squashing rewrites the 13 into one new SHA and
   forces a patch-id rebase of the platform branch.
3. Push `feat/provider-neutral-booking-orchestration`; open **Platform PR** (base
   `feat/stripe-connect-us` ← head, so it shows **105** commits, excluding the 13 payment ones).
4. After the Payment PR merges, retarget the Platform PR base to `main` (GitHub auto-retargets when
   the base branch is deleted). Because the 13 payment SHAs are identical in both histories, GitHub
   excludes them — **no duplicate commit enters `main`.**

**Dependency note (honest):** the platform/booking commits _do_ modify payment source (13 files,
+375 lines — the void/refund capability extensions added in P5.3B Phases 5–6). This means the
**platform track depends on the payment track** (correct direction for payment-first). It does **not**
prevent separating payments _out first_, because payments are the base prefix and contain none of
those later edits. Verified: the payment PR at `fbce16a` builds and tests green **without** any
platform/booking code.

## 4. Payment-track verification (executed at the payment tip `fbce16a`, in isolation)

Run in a detached worktree at `fbce16a` (platform/booking code absent), root tree undisturbed:

| Gate                                          | Result                                            |
| --------------------------------------------- | ------------------------------------------------- |
| Payment suite (`src/payments`)                | ✅ **34 suites / 257 tests passed**               |
| Adapters (Stripe/PayPal/Square/Razorpay/mock) | ✅ included above                                 |
| Currency routing (US→Stripe, IN→Razorpay)     | ✅ server-side `payment-provider.resolver.ts`     |
| Webhook signature verification                | ✅ present (Stripe/Razorpay sig verify)           |
| Idempotency / refund (feature-gated)          | ✅ included in payment suite                      |
| TypeScript (`tsc --noEmit`)                   | ✅ clean¹                                         |
| Prisma schema validate                        | ✅ valid                                          |
| Secret scan (live-key literals)               | ✅ clean — only key-**prefix** guards, no secrets |

¹ tsc at the payment tip used the HEAD-generated `@prisma/client` (a superset via junction); the
payment source compiled clean against it. A CI run regenerates the client from the payment-tip
schema — expected to remain clean since payment models are unchanged between the two schemas.

## 5. Recommendation

**CONDITIONAL GO** for the Payment PR (code gates green; merge preserving SHAs). Platform PR opens
stacked on the payment branch and should merge **after** the payment PR. Neither is merged by this
preparation — both are pushed and opened for CI + owner review per owner instruction.
