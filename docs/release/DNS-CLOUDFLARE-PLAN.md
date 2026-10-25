# DNS inventory and Cloudflare migration plan (eticketsgo.com)

Prepared 2026-10-25. **Nothing here has been changed.** The nameserver change and every DNS
edit need the owner's authorization, and the owner performs or approves each step.

## 1. Why

The apex `eticketsgo.com` is served by GoDaddy's forwarding service (A 3.33.251.168 and
15.197.225.128). Measured 2026-10-25:

| Request                                             | GET                               | HEAD |
| --------------------------------------------------- | --------------------------------- | ---- |
| `https://eticketsgo.com/`, `http://eticketsgo.com/` | 301 `https://www.eticketsgo.com/` | 405  |
| any path or query (`/events?city=x`, `/privacy`)    | 404                               | 405  |

Required: every apex URL answers a permanent redirect to `https://www.eticketsgo.com` with the
same path and query, for GET and HEAD, over HTTP and HTTPS, with no loop. GoDaddy forwarding
cannot do HEAD. GoDaddy DNS cannot point the apex at Railway (no CNAME at the apex, no ALIAS
to a hostname). Cloudflare (free plan) can do both: a Redirect Rule on a proxied apex record.

## 2. Inventory (public DNS, queried 2026-10-25 against 8.8.8.8)

Authoritative: `ns05.domaincontrol.com`, `ns06.domaincontrol.com` (GoDaddy).

| Name                                                                        | Type  | Value                                                                               | Purpose                              |
| --------------------------------------------------------------------------- | ----- | ----------------------------------------------------------------------------------- | ------------------------------------ |
| `@`                                                                         | A     | 3.33.251.168, 15.197.225.128                                                        | GoDaddy forwarding (to be replaced)  |
| `@`                                                                         | MX 0  | `eticketsgo-com.mail.protection.outlook.com`                                        | Microsoft 365 mail (support@ inbox)  |
| `@`                                                                         | TXT   | `v=spf1 include:spf.protection.outlook.com -all`                                    | SPF for Microsoft 365                |
| `@`                                                                         | TXT   | `google-site-verification=7raXg0p-Nx1F26PLL1VclSW57HgbZDhbBHRoTGw-0tk`              | Search Console Domain property       |
| `_dmarc`                                                                    | TXT   | `v=DMARC1; p=quarantine; adkim=r; aspf=r; rua=mailto:dmarc_rua@onsecureserver.net;` | DMARC (reports to GoDaddy's service) |
| `mail`                                                                      | MX 10 | `feedback-smtp.ap-south-1.amazonses.com`                                            | SES custom MAIL FROM (bounces)       |
| `mail`                                                                      | TXT   | `v=spf1 include:amazonses.com ~all`                                                 | SPF for SES MAIL FROM                |
| `autodiscover`                                                              | CNAME | `autodiscover.outlook.com`                                                          | Microsoft 365                        |
| `enterpriseregistration`                                                    | CNAME | `enterpriseregistration.windows.net`                                                | Microsoft 365 / Entra                |
| `enterpriseenrollment`                                                      | CNAME | `enterpriseenrollment-s.manage.microsoft.com`                                       | Microsoft 365 / Intune               |
| `www`                                                                       | CNAME | `0es2hh9f.up.railway.app`                                                           | PROD customer-web                    |
| `api`                                                                       | CNAME | `n37igjrk.up.railway.app`                                                           | PROD api                             |
| `admin`                                                                     | CNAME | `txc8niw0.up.railway.app`                                                           | PROD admin-web                       |
| `organizer`                                                                 | CNAME | `8vaccm00.up.railway.app`                                                           | PROD organizer-web                   |
| `qa`                                                                        | CNAME | `1fbkzr49.up.railway.app`                                                           | QA customer-web                      |
| `api-qa`                                                                    | CNAME | `ktndx6oh.up.railway.app`                                                           | QA api                               |
| `admin-qa`                                                                  | CNAME | `s8wvm98p.up.railway.app`                                                           | QA admin-web                         |
| `organizer-qa`                                                              | CNAME | `31by3s2m.up.railway.app`                                                           | QA organizer-web                     |
| `_railway-verify.{www,api,admin,organizer,qa,api-qa,admin-qa,organizer-qa}` | TXT   | `railway-verify=...` (one per host)                                                 | Railway domain verification          |

**Not discoverable from outside, so the GoDaddy export is mandatory before migrating:** the
Amazon SES DKIM records (three CNAMEs named `<token>._domainkey`), any SES verification TXT,
any other `_domainkey`, `_acme-challenge`, SRV or CAA records, and records on names not listed
above. Microsoft 365 DKIM (`selector1/selector2._domainkey`) is **not** published today: M365
mail is not DKIM-signed with the domain (a separate improvement, not part of this move).
No AAAA and no CAA records were found. UAT has no DNS names.

## 3. Migration plan

### Step 0 - Prepare (no impact)

1. GoDaddy > Domain > DNS > **Export zone file** (BIND). Keep it as the rollback source and
   attach it to this document's PR or the owner's records.
2. Compare the export with section 2; every record in the export is copied, including any
   not listed here.
3. Lower nothing yet; GoDaddy NS TTLs are fixed by the registry.

### Step 1 - Build the zone in Cloudflare (no impact)

1. Cloudflare > Add a domain > `eticketsgo.com` > Free plan. Let it scan, then **reconcile with
   the export record by record**.
2. Proxy status - **DNS only (grey cloud)** for: every Railway CNAME (www, api, admin,
   organizer, qa, api-qa, admin-qa, organizer-qa), all `_railway-verify` TXT, all mail records
   (MX, `mail`, SPF, DMARC, DKIM CNAMEs, autodiscover and the other Microsoft CNAMEs). Railway
   issues its own certificates; proxying the Railway hosts would change TLS and caching and is
   out of scope.
3. Apex: delete the GoDaddy forwarding A records in Cloudflare's copy and add
   `A @ 192.0.2.1` **Proxied (orange)**. The address is a placeholder; the proxy answers
   before it is ever used. (Alternatively `AAAA @ 100::`.)
4. **Rules > Redirect Rules > Create (Single Redirect):**
   - When: Hostname equals `eticketsgo.com`.
   - Then: Dynamic, expression `concat("https://www.eticketsgo.com", http.request.uri.path)`,
     status **301**, **Preserve query string: on**.
5. SSL/TLS: mode **Full**; "Always Use HTTPS" on (applies only to the proxied apex).
6. Do not enable features that touch the Railway hosts (they are DNS-only, so none apply).

### Step 2 - Switch nameservers (the change; owner only)

1. Note the two Cloudflare nameservers.
2. GoDaddy > Domain > Nameservers > **I'll use my own nameservers** > enter both. Keep
   DNSSEC **off** at GoDaddy for now (if it were on, turn it off a day before).
3. Propagation: minutes to 24 h. Both zones answer identically for every record except the
   apex during this time, so nothing breaks.

### Step 3 - Verify (Eng, read-only)

```
for m in "" "-I"; do
  for u in https://eticketsgo.com/ "https://eticketsgo.com/events?city=pune&q=jazz" \
           http://eticketsgo.com/privacy https://eticketsgo.com/sitemap.xml; do
    curl -s $m -o /dev/null -w "%{http_code} %{redirect_url}\n" "$u"; done; done
# expect 301 and Location https://www.eticketsgo.com/<same path>?<same query>, for GET and HEAD
curl -s -o /dev/null -w "%{http_code}\n" -L --max-redirs 3 https://eticketsgo.com/events   # 200, no loop
node apps/customer-web/scripts/seo-check.mjs https://www.eticketsgo.com --expect indexable
nslookup -type=MX eticketsgo.com ; nslookup -type=TXT eticketsgo.com   # mail records intact
```

Then every service: www, api `/api/health` and `/api/ready`, admin, organizer, qa, api-qa,
admin-qa, organizer-qa all 200. Email: send a test to support@eticketsgo.com from outside
(Microsoft 365), and one SES email (a password reset on QA) and check the received headers
show `dkim=pass` and `spf=pass` for SES. Railway dashboard: every custom domain still shows
"verified".

### Rollback

At GoDaddy, set nameservers back to **GoDaddy defaults**. GoDaddy's zone is untouched by the
move, so it answers exactly as before (including the old forwarding) once resolvers refresh.
If only the redirect misbehaves, disable the Redirect Rule in Cloudflare (instant).

## 4. Risks

- A record missing from Cloudflare stops that function (mail, SES DKIM, Railway verification).
  Mitigation: the zone export comparison in Step 0 and the checks in Step 3.
- DMARC is `p=quarantine`: if SES DKIM records were lost, SES mail would fail alignment and be
  quarantined. Check `dkim=pass` before considering the move done.
- Search Console Domain property stays verified as long as the `google-site-verification` TXT
  is copied.
