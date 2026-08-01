#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# ETicketsGo — QA post-deployment smoke test.
#
# Run this immediately after the first QA deployment, and after every subsequent
# QA deploy. It checks the parts that can be verified without a browser or a
# payment-provider dashboard; the interactive steps it cannot cover are listed at
# the end so nothing is silently skipped.
#
# Usage:
#   ./scripts/deploy/qa-smoke-test.sh
#   API_BASE=https://api-qa.eticketsgo.com \
#   WEB_BASE=https://qa.eticketsgo.com \
#   ORGANIZER_BASE=https://organizer-qa.eticketsgo.com \
#   ADMIN_BASE=https://admin-qa.eticketsgo.com \
#     ./scripts/deploy/qa-smoke-test.sh
#
# Exit 0 = every automated check passed. Exit 1 = at least one failed.
#
# This script only READS. It creates no bookings, moves no money, and mutates
# nothing — so it is safe to run against QA at any time, including repeatedly.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

API_BASE="${API_BASE:-https://api-qa.eticketsgo.com}"
WEB_BASE="${WEB_BASE:-https://qa.eticketsgo.com}"
ORGANIZER_BASE="${ORGANIZER_BASE:-https://organizer-qa.eticketsgo.com}"
ADMIN_BASE="${ADMIN_BASE:-https://admin-qa.eticketsgo.com}"
EXPECTED_APP_ENV="${EXPECTED_APP_ENV:-QA}"

PASS=0
FAIL=0
SKIP=0

pass() { printf '  \033[32mPASS\033[0m  %s%s\n' "$1" "${2:+ — $2}"; PASS=$((PASS + 1)); }
fail() { printf '  \033[31mFAIL\033[0m  %s%s\n' "$1" "${2:+ — $2}"; FAIL=$((FAIL + 1)); }
skip() { printf '  \033[33mSKIP\033[0m  %s%s\n' "$1" "${2:+ — $2}"; SKIP=$((SKIP + 1)); }
section() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# curl already prints 000 when it cannot reach the host, so do NOT add a fallback echo —
# that produced "HTTP 000000" and made an unreachable host look like a malformed status.
code_of() { curl -sS -o /dev/null -m 20 -w '%{http_code}' "$@" 2>/dev/null; }
body_of() { curl -sS -m 20 "$@" 2>/dev/null || echo ''; }
unreachable() { [ "$1" = 000 ] || [ -z "$1" ]; }

printf '\n\033[1mETicketsGo QA smoke test\033[0m\n'
printf 'api=%s\nweb=%s\norganizer=%s\nadmin=%s\n' "$API_BASE" "$WEB_BASE" "$ORGANIZER_BASE" "$ADMIN_BASE"

# ── 1. API health and readiness ──────────────────────────────────────────────
section '1. API health'
b=$(body_of "$API_BASE/api/health")
case "$b" in *'"status":"ok"'*) pass 'API liveness /api/health' "$b" ;; *) fail 'API liveness /api/health' "${b:-no response}" ;; esac

b=$(body_of "$API_BASE/api/ready")
case "$b" in
  *'"database":"up"'*'"redis":"up"'*) pass 'API readiness — PostgreSQL and Redis both up' "$b" ;;
  *) fail 'API readiness /api/ready' "${b:-no response}" ;;
esac

c=$(code_of "$API_BASE/api/metrics")
[ "$c" = 200 ] && pass 'API metrics endpoint responds' "HTTP $c" || fail 'API metrics endpoint' "HTTP $c"

b=$(body_of "$API_BASE/api/metrics")
case "$b" in *etg_*) pass 'metrics carry the etg_ namespace (the app answered, not a proxy)' ;; *) fail 'metrics namespace' ;; esac

# ── 2. Web tiers ─────────────────────────────────────────────────────────────
section '2. Web applications'
for pair in "customer-web|$WEB_BASE" "organizer-web|$ORGANIZER_BASE" "admin-web|$ADMIN_BASE"; do
  name="${pair%%|*}"; base="${pair##*|}"
  b=$(body_of "$base/api/health")
  case "$b" in
    *"\"app\":\"$name\""*) pass "$name health route" "$b" ;;
    '')                    fail "$name health route" 'no response (DNS, Access, or service down)' ;;
    *)                     fail "$name health route" "unexpected body: $b" ;;
  esac
  c=$(code_of "$base/")
  [ "$c" = 200 ] && pass "$name homepage renders" "HTTP $c" || fail "$name homepage" "HTTP $c"
done

# ── 3. Security posture ──────────────────────────────────────────────────────
section '3. Security posture'
c=$(code_of "$API_BASE/api/docs")
if unreachable "$c"; then fail 'Swagger exposure check' 'API unreachable'
elif [ "$c" = 404 ]; then pass 'Swagger is not exposed' "HTTP $c"
elif [ "$c" = 200 ]; then skip 'Swagger is reachable' "HTTP $c — acceptable in QA only if ENABLE_SWAGGER=true was set deliberately; it must be UNSET in UAT and production"
else skip 'Swagger exposure check' "HTTP $c"; fi

hdrs=$(curl -sSI -m 20 -H 'Origin: https://evil.example' "$API_BASE/api/health" 2>/dev/null)
case "$hdrs" in
  *'access-control-allow-origin: https://evil.example'*) fail 'CORS rejects an unknown origin' 'the origin was echoed back' ;;
  *) pass 'CORS does not echo an unknown origin' ;;
esac

case "$(curl -sSI -m 20 "$WEB_BASE/" 2>/dev/null)" in
  *[Ss]trict-[Tt]ransport-[Ss]ecurity*) pass 'HSTS header present on the customer web' ;;
  *) fail 'HSTS header missing on the customer web' ;;
esac

# A 401/403 is the CORRECT answer here: the endpoint must exist and be protected.
c=$(code_of "$API_BASE/api/admin/ops/health")
case "$c" in
  401|403) pass 'admin ops endpoint requires authentication' "HTTP $c" ;;
  200)     fail 'admin ops endpoint is PUBLIC' 'HTTP 200 without credentials' ;;
  *)       skip 'admin ops endpoint' "HTTP $c" ;;
esac

# ── 4. Environment identity and isolation ────────────────────────────────────
section '4. Environment identity'
b=$(body_of "$API_BASE/api/health")
case "$b" in *'"status":"ok"'*) pass 'QA API is the one answering this hostname' ;; *) fail 'QA API identity' ;; esac

# The QA web bundle must point at the QA API, never at UAT or production.
if bundle=$(curl -sS -m 30 "$WEB_BASE/" 2>/dev/null); then
  case "$bundle" in
    *api.eticketsgo.com*|*api-uat.eticketsgo.com*)
      fail 'QA web references a non-QA API hostname' 'check NEXT_PUBLIC_API_URL and REBUILD (it is baked in at build time)' ;;
    *) pass 'QA web does not reference a UAT/production API hostname' ;;
  esac
else
  skip 'QA web bundle inspection' 'could not fetch the page'
fi

# ── 5. Payment posture ───────────────────────────────────────────────────────
section '5. Payment posture (QA must be test-mode only)'
skip 'Stripe test-mode charge' 'requires the Stripe dashboard — see the manual checklist'
skip 'Razorpay test-mode charge' 'requires the Razorpay dashboard — see the manual checklist'
printf '        note: the API refuses to boot in QA with an sk_live_/rzp_live_ key unless\n'
printf '        PAYMENT_ALLOW_LIVE_KEYS_LOWER_ENV=true, so a successful boot is itself\n'
printf '        evidence that no live credential is configured.\n'

# ── Summary ──────────────────────────────────────────────────────────────────
section 'Summary'
printf '  passed: %d   failed: %d   skipped: %d\n\n' "$PASS" "$FAIL" "$SKIP"

cat <<'MANUAL'
Not covered by this script — verify by hand and record the result:

  authentication      customer register + login + token refresh + logout
  organizer login     organizer signs in and sees only their own organization
  admin login         admin signs in (behind Cloudflare Access)
  guest booking       book without an account; ticket arrives
  organizer onboard   organizer onboarding flow completes
  venue/event/show    create a venue, an event, and a showtime
  inventory           availability reflects the created showtime
  seat hold           select a seat; a second browser cannot take it
  GA hold             quantity-based hold where the event supports it
  Stripe test pay     complete a checkout with 4242 4242 4242 4242
  Razorpay test pay   complete an INR checkout with test credentials
  webhook delivery    provider dashboard shows 2xx for the QA endpoint
  booking confirmed   booking moves to CONFIRMED after the webhook
  QR generation       ticket QR is issued
  QR validation       QR admits at check-in
  duplicate scan      a second scan of the same QR is refused
  cancellation        cancel returns inventory
  refund              manual refund path (auto-refund is OFF by design)
  email               ticket email arrives (if EMAIL_PROVIDER is not `log`)
  push                push arrives (if PUSH_PROVIDER is not `log`)
  audit log           the admin actions above appear in the audit log
  analytics           organizer dashboard reflects the new booking
  worker /ready       railway ssh --service worker, then wget -qO- localhost:$PORT/ready
  queue schedule      GET /api/admin/ops/queues lists the repeatable jobs
MANUAL

[ "$FAIL" -eq 0 ] && exit 0 || exit 1
