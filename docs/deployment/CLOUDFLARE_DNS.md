# ETicketsGo — Cloudflare & DNS Configuration

> Documentation only. **No Cloudflare change has been made** — this repository contains no
> infrastructure automation for Cloudflare (no Terraform, no API scripts), so every step
> below is for the domain owner to perform in the Cloudflare dashboard.
>
> Companion: [Railway Deployment Runbook](./RAILWAY_DEPLOYMENT_RUNBOOK.md)

---

## 1. Custom domains — the order that works

Do it in this order. Adding the DNS record first causes Cloudflare to serve a 5xx until
Railway knows about the hostname, and adding it proxied first can stop Railway's
certificate issuance from completing.

1. **Railway first.** Service → **Settings → Networking → Custom Domain** → enter the
   hostname. Railway shows a CNAME target such as `abc123.up.railway.app`. Copy it.
2. **Cloudflare second.** DNS → **Add record** → `CNAME` → name → target → **DNS only**
   (grey cloud) initially.
3. **Wait for Railway to issue the certificate** (Networking shows the domain as active).
4. **Then enable the proxy** (orange cloud) if you want Cloudflare in the path.

Reverse that order and you will be debugging a 522 that is really a certificate problem.

---

## 2. CNAME records

Replace `<...>.up.railway.app` with the target Railway shows for each service.

### QA — `ETicketsGo-QA`

| Type  | Name           | Target                              | Proxy   |
| ----- | -------------- | ----------------------------------- | ------- |
| CNAME | `qa`           | `<customer-web-qa>.up.railway.app`  | Proxied |
| CNAME | `api-qa`       | `<api-qa>.up.railway.app`           | Proxied |
| CNAME | `organizer-qa` | `<organizer-web-qa>.up.railway.app` | Proxied |
| CNAME | `admin-qa`     | `<admin-web-qa>.up.railway.app`     | Proxied |

### UAT — `ETicketsGo-UAT`

| Type  | Name            | Target                               | Proxy   |
| ----- | --------------- | ------------------------------------ | ------- |
| CNAME | `uat`           | `<customer-web-uat>.up.railway.app`  | Proxied |
| CNAME | `api-uat`       | `<api-uat>.up.railway.app`           | Proxied |
| CNAME | `organizer-uat` | `<organizer-web-uat>.up.railway.app` | Proxied |
| CNAME | `admin-uat`     | `<admin-web-uat>.up.railway.app`     | Proxied |

### Production — `ETicketsGo-Production`

| Type  | Name        | Target                                | Proxy   |
| ----- | ----------- | ------------------------------------- | ------- |
| CNAME | `@` (apex)  | `<customer-web-prod>.up.railway.app`  | Proxied |
| CNAME | `www`       | `<customer-web-prod>.up.railway.app`  | Proxied |
| CNAME | `api`       | `<api-prod>.up.railway.app`           | Proxied |
| CNAME | `organizer` | `<organizer-web-prod>.up.railway.app` | Proxied |
| CNAME | `admin`     | `<admin-web-prod>.up.railway.app`     | Proxied |

Apex CNAME works on Cloudflare via CNAME flattening.

**The `worker` service gets no DNS record.** It is internal-only; a public hostname would
expose `/metrics`.

---

## 3. SSL mode

**SSL/TLS → Overview → Full (strict).** Nothing less.

- _Flexible_ terminates TLS at Cloudflare and talks **plaintext HTTP to Railway** — the
  browser shows a padlock while the leg carrying session cookies and payment data is
  unencrypted. Never use it.
- _Full_ encrypts the origin leg but does not verify the certificate.
- **Full (strict)** encrypts and verifies. Railway issues a valid certificate, so this
  works with no extra configuration.

Also set:

| Setting                                            | Value                                           | Why                                                                              |
| -------------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------- |
| SSL/TLS → Edge Certificates → **Always Use HTTPS** | On                                              | Redirects HTTP at the edge                                                       |
| **Minimum TLS Version**                            | 1.2                                             | 1.0/1.1 are deprecated and a PCI finding                                         |
| **HSTS**                                           | Enable, `max-age` 12 months, include subdomains | Enable only once _every_ subdomain is confirmed HTTPS-ready — it is hard to undo |
| **Automatic HTTPS Rewrites**                       | On                                              |                                                                                  |

---

## 4. Proxying

| Hostname                             | Proxy      | Reasoning                                                     |
| ------------------------------------ | ---------- | ------------------------------------------------------------- |
| `eticketsgo.com`, `www`              | ✅ Proxied | DDoS protection, static caching, WAF                          |
| `api.eticketsgo.com`                 | ✅ Proxied | WAF and rate limiting are worth it; all caching disabled (§7) |
| `organizer.*`, `admin.*`             | ✅ Proxied | Needed for Cloudflare Access                                  |
| `qa.*`, `uat.*` and their subdomains | ✅ Proxied | **Required** for Cloudflare Access (§9)                       |

If you hit a hard-to-diagnose origin error, greying the cloud temporarily is a legitimate
bisection step — but re-enable it, because Access stops working while it is off.

---

## 5. WebSocket support

**Network → WebSockets → On** (it is on by default on all plans).

This application does not currently open a WebSocket — the web apps poll over HTTPS. Leave
the setting enabled anyway so a future live seat-map or check-in stream does not require a
Cloudflare change during a release.

---

## 6. API caching exclusions

**The single most important Cloudflare rule set here.** Caching an API response that
depends on inventory, identity, or payment state causes overselling, cross-customer data
exposure, or duplicate charges. Cloudflare does not cache JSON by default, but a
misapplied "Cache Everything" rule elsewhere can catch these paths — so make the exclusion
explicit rather than relying on the default.

**Caching → Cache Rules → Create rule**

| Rule                            | Expression                                                                                    | Setting          |
| ------------------------------- | --------------------------------------------------------------------------------------------- | ---------------- |
| Never cache the API             | `(http.host eq "api.eticketsgo.com")`                                                         | **Bypass cache** |
| Never cache admin               | `(http.host eq "admin.eticketsgo.com")`                                                       | **Bypass cache** |
| Never cache organizer           | `(http.host eq "organizer.eticketsgo.com")`                                                   | **Bypass cache** |
| Never cache customer app routes | `(http.host eq "eticketsgo.com" and not starts_with(http.request.uri.path, "/_next/static"))` | **Bypass cache** |

Repeat for the QA and UAT hostnames.

### Must never be cached

Every one of these is either inventory-sensitive, identity-sensitive, or money-sensitive:

| Path                                                      | Why                                                             |
| --------------------------------------------------------- | --------------------------------------------------------------- |
| `/api/bookings/*`                                         | A cached booking response serves one customer another's booking |
| `/api/shows/*/availability`, `/api/events/*/availability` | Stale availability oversells                                    |
| `/api/inventory/*`, seat-lock endpoints                   | A cached lock state double-books a seat                         |
| `/api/checkout/*`                                         | Checkout state is per-session                                   |
| `/api/payments/*`                                         | Payment state must never be stale or shared                     |
| `/api/auth/*`                                             | A cached token response hands one user another's session        |
| `/api/admin/*`                                            | Privileged data                                                 |
| `/api/organizer/*`                                        | Tenant-scoped data                                              |
| `/api/payments/webhook/*`                                 | Inbound POSTs; must always reach the origin                     |
| `/api/health`, `/api/ready`, `/api/metrics`               | A cached "ok" hides a real outage                               |

### Safe to cache

| Path                                          | TTL               | Note                                                          |
| --------------------------------------------- | ----------------- | ------------------------------------------------------------- |
| `/_next/static/*`                             | 1 year, immutable | Content-hashed filenames                                      |
| `/_next/image/*`                              | 1 day             |                                                               |
| `/favicon.ico`, `/robots.txt`, fonts          | 1 day             |                                                               |
| Marketing pages (`/about`, `/faq`, `/blog/*`) | 1 hour, edge only | Not `/discover` or `/events/*` — those show live availability |

---

## 7. Static asset caching

Next.js emits content-hashed filenames under `/_next/static/`, so they can be cached
aggressively and forever — a new deploy produces new filenames.

**Cache Rules:** match `starts_with(http.request.uri.path, "/_next/static")` → Cache
eligibility **Eligible for cache**, Edge TTL **1 year**, Browser TTL **1 year**.

Do **not** blanket-cache `/_next/*`: `/_next/data/*` carries per-request page data.

---

## 8. Webhook endpoint exclusions

Payment providers cannot authenticate through Cloudflare Access and will not follow a
challenge. Exclude webhook paths from **both** Access and any bot/WAF challenge, or
Stripe and Razorpay will silently stop delivering.

**Security → WAF → Custom rules** — create a **Skip** rule _above_ the others:

```
(http.request.uri.path contains "/api/payments/webhook/")
```

Skip: Cloudflare Managed Rules, Rate limiting, Bot Fight Mode, Super Bot Fight Mode.

Also list the same path prefix as a **bypass** policy in every Access application that
covers the API hostname.

**Do not** consider this a security hole: both webhook handlers verify the provider's
cryptographic signature against an environment-specific secret before acting, and an
unsigned or wrongly-signed request is rejected. That signature check — not network
filtering — is the real control.

Optionally tighten with an IP allowlist of the providers' published webhook ranges, but
treat that as defence in depth and keep it maintained, or it will cause an outage when a
provider changes ranges.

---

## 9. QA / UAT access protection

**QA and UAT must not be publicly reachable.** They hold test data, run with looser
settings, and expose Swagger in QA. They are also the easiest place for a search engine to
index a duplicate of the product.

**Recommended: Cloudflare Access** (Zero Trust → Access → Applications).

For each of `qa.*`, `api-qa.*`, `organizer-qa.*`, `admin-qa.*` and the UAT equivalents:

1. **Add an application** → Self-hosted → set the domain.
2. **Session duration:** 24 hours.
3. **Policy:** Allow → _Emails ending in_ `@yourcompany.com`, plus named external UAT
   testers.
4. **Bypass policy** for `/api/payments/webhook/*` so sandbox webhooks still arrive.
5. Identity provider: your Google Workspace / Microsoft Entra / GitHub org, or one-time
   PIN by email for external testers.

**Also:**

- Add `X-Robots-Tag: noindex` (Transform Rules → Modify Response Header) on all QA/UAT
  hostnames, so a leaked link cannot get indexed.
- Never point a QA/UAT hostname at a production Railway service.

**Production admin and organizer apps.** Put `admin.eticketsgo.com` behind Access too. It
is a platform-administration surface; application login is authentication, but Access adds
a second, independent gate in front of it.

---

## 10. Production DNS cutover

If `eticketsgo.com` already serves something, treat the cutover as a scheduled change.

**Before:**

1. Lower the TTL on the records you will change to **60 seconds**, at least 24 hours ahead.
   The old TTL still governs caches until it expires — this is the step that determines
   how fast you can roll back.
2. Add the custom domains in Railway and confirm certificates are issued.
3. Verify the production environment fully against the
   [Go-Live Checklist](./RAILWAY_GO_LIVE_CHECKLIST.md) using its `*.up.railway.app`
   hostnames, before any DNS points at it.
4. Write the rollback: the exact previous record values, saved somewhere you can reach
   during an incident.

**Cutover:**

5. Choose a low-traffic window with no event on sale.
6. Change `api` first, verify, then `organizer` and `admin`, then the customer apex and
   `www` last. The API is the dependency; flipping the frontends first points them at an
   API that may not be ready.
7. Watch `/api/ready`, Sentry, and booking success rate continuously.
8. Confirm from multiple networks (`dig @1.1.1.1`, `dig @8.8.8.8`, a mobile connection).

**After:**

9. Leave TTL at 60s for 24–48 hours.
10. Once stable, raise TTL back to 3600s.
11. Only then decommission the old origin — keep it running and reachable until you are
    certain, because it is your fastest rollback.

**Rollback:** revert the CNAME to the saved previous value. With a 60s TTL, propagation is
minutes. This is precisely why step 1 comes 24 hours early.

---

## 11. Rate limiting (recommended)

The API applies its own throttling (`ThrottlerGuard`, 120 req/min globally, 10/min on auth
routes, keyed on the real client IP via `TRUST_PROXY_HOPS=1`). Cloudflare rate limiting in
front of it absorbs volumetric abuse before it reaches the origin at all.

| Rule          | Expression                                            | Limit          |
| ------------- | ----------------------------------------------------- | -------------- |
| Auth abuse    | `starts_with(http.request.uri.path, "/api/auth/")`    | 20 / min / IP  |
| Booking abuse | `starts_with(http.request.uri.path, "/api/bookings")` | 60 / min / IP  |
| General API   | `http.host eq "api.eticketsgo.com"`                   | 600 / min / IP |

Do not rate-limit `/api/payments/webhook/*` — a provider retry burst is legitimate.

---

## 12. Verifying the configuration

```bash
# Resolution and proxy status (proxied hostnames return Cloudflare IPs)
dig +short eticketsgo.com
dig +short api.eticketsgo.com

# TLS + security headers
curl -sI https://eticketsgo.com | grep -iE 'strict-transport|cf-cache-status|server'

# API must NOT be cached — expect DYNAMIC or BYPASS, never HIT
curl -sI https://api.eticketsgo.com/api/health | grep -i cf-cache-status

# Static assets SHOULD be cached — expect HIT on the second request
curl -sI https://eticketsgo.com/_next/static/... | grep -i cf-cache-status

# QA must be protected — expect a redirect to the Access login, not a 200
curl -sI https://qa.eticketsgo.com | head -1

# HTTP must redirect to HTTPS
curl -sI http://eticketsgo.com | head -1
```
