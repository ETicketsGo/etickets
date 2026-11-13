# ETicketsGo: Data residency, database, security and privacy audit

**Date:** 2026-11-12. **Mode:** read-only. Nothing was changed, deployed or merged.
**Code baseline:** main `9bb1ccba`. PROD API is on `5c10d509`.

**Evidence labels**

- **V** = Verified: I saw it in live infrastructure, the database or the code.
- **I** = Inferred: reasoned from evidence, not observed directly.
- **NV** = Not Verified.

**How the database was read:** only server settings, the catalogue and aggregate counts. No personal records were read or exported.

---

## 1. Executive summary

**Can ETicketsGo lawfully keep using one shared database for India and the USA? Yes, today. The verdict is CONDITIONAL GO.**

**What is legal today.**

- No law in force requires ordinary Indian or US personal data to stay in its own country.
- India's DPDP Act cross-border rule (s.16) is a negative list. It and most DPDP obligations start on **13 May 2027**, and no country has been restricted.
- RBI payment-data localisation binds Razorpay, the payment aggregator. It does not bind a merchant that stores only gateway ids, amounts and status.

**Where all the data lives (V).** All PROD and QA data is in **Railway us-west2 (US West)**. That covers Postgres, Redis, the backups volume and every service. **No Indian personal data is stored in India.**

**What needs fixing.** The risks are operational, not residency:

| Risk                                                                                   | Status                                                                        |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Full payment-provider webhook payloads, including payer email, UPI VPA and card last-4 | Kept with no retention limit (V on PROD)                                      |
| Account deletion                                                                       | Leaves personal data behind                                                   |
| Database access                                                                        | The app uses the `postgres` superuser and there is no row-level security      |
| Backups                                                                                | Exist only on the same Railway project and region; off-site backup is OFF (V) |
| India grievance officer and privacy contact                                            | None                                                                          |
| CERT-In 6-hour breach reporting                                                        | No process for it                                                             |
| CERT-In logs held 180 days "within Indian jurisdiction"                                | Not done; needs counsel                                                       |

**Recommendation.**

- **Stay on Option A, one shared database, now.** Fix the P1 items before scale. Add a data-region tag so the platform can move to **Option C (shared global identity plus regional data stores)** later.
- Do that move only if a defined trigger fires (section 7). Separate databases now would roughly double infrastructure and operations cost for no legal gain.

---

## 2. Current infrastructure and verified hosting regions

| Component                                                    | PROD                                                                                                   | QA       | Evidence                                                           |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ | -------- | ------------------------------------------------------------------ |
| Postgres 16.15                                               | **us-west2**, volume 260 MB of 5 GB, database 19 MB                                                    | us-west2 | V: Railway API `multiRegionConfig` plus volume region; `version()` |
| Redis                                                        | us-west2, private only                                                                                 | us-west2 | V                                                                  |
| Backups volume (`/backups`, nightly pg_dump)                 | us-west2, **same project and region as the DB**                                                        | us-west2 | V                                                                  |
| Off-site backup (S3, default ap-south-1 Mumbai)              | **OFF**: no `BACKUP_OFFSITE_*` variables                                                               | OFF      | V (variable names)                                                 |
| api, worker, customer-web, organizer-web, admin-web, db-seed | us-west2, 1 replica (QA api has 2)                                                                     | us-west2 | V                                                                  |
| Public exposure                                              | Only api, www, organizer and admin domains. **Postgres and Redis have no TCP proxy or public domain.** | —        | V                                                                  |
| DB in transit                                                | Server has `ssl=on`; the app connects over the private network with no `sslmode`                       | Same     | V. Encryption of the private network itself: I (Railway docs).     |
| DB at rest                                                   | Railway volume encryption                                                                              | —        | NV (provider claim, not verified)                                  |
| AWS SES/SNS email                                            | `AWS_REGION=ap-south-1` (Mumbai)                                                                       | Same     | V                                                                  |
| SMS                                                          | MSG91 (India), Twilio (US/CA), set by `SMS_PROVIDER_BY_MARKET`                                         | Same     | V. Provider hosting regions: NV.                                   |
| Payments                                                     | Razorpay (live) and Stripe keys present                                                                | mock     | V (names only)                                                     |
| Sentry                                                       | **No `SENTRY_DSN` on PROD api or worker**, so error monitoring is off                                  | —        | V                                                                  |
| Secrets                                                      | `SECRET_MANAGER_PROVIDER=railway`, values in Railway variables                                         | —        | V                                                                  |
| Images                                                       | Stored in Postgres; no object store                                                                    | —        | I                                                                  |
| Analytics and trackers                                       | None                                                                                                   | —        | V (code)                                                           |

Railway's public regions are US West, US East, EU West and Singapore. There is no India region. **I, not checked this session.**

---

## 3. Personal-data inventory and data-flow map

**Volume on PROD (aggregate counts, V).** 141 tables, 17 users, 15 bookings (12 INR, 3 USD), 12 payments (5 Razorpay, 7 mock), 185 webhook rows, 14 OTP rows, 421 audit rows.

| Class                  | Where                                                                                                                                                                                            | Protection           |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------- |
| Identity and contact   | `User` (email, phone, name, countryOfResidence), `Booking` (buyerName, buyerEmail), `Ticket` (holder and attendee fields, custom fields), TicketInvite, Feedback, CrmLead, Organization contacts | Plaintext (V)        |
| Consent                | `MarketingConsent` (email, phone, IP, user agent, policyVersion), `CommunicationConsent` (hashed subject)                                                                                        | V                    |
| Sensitive: credentials | Passwords bcrypt-12; OTPs and email codes bcrypt-10; reset, invite, refresh and guest tokens hashed; admin MFA secret AES-GCM                                                                    | Good (V)             |
| Sensitive: financial   | Full payout bank account encrypted with **AES-256-GCM** (`PAYOUT_BANK_ENCRYPTION_KEY`); last-4 in clear                                                                                          | Good (V)             |
| Sensitive: tax ids     | `Organization.taxRegistrationNumber` (PAN/GSTIN/EIN), `OrganizerBillingAccount.taxId`                                                                                                            | **Plaintext** (V)    |
| Payment                | `Payment` holds provider refs, amount and status. **No card number, CVV or VPA column.**                                                                                                         | V                    |
| Payment, in effect     | `WebhookEvent.payload` holds the full provider event: **112 of 185 rows contain email keys, 4 contain VPA, 20 contain card last-4**, oldest 2026-10-06, never purged                             | **Risk (V on PROD)** |
| Operational            | RefreshToken (IP, user agent), UserDevice (Expo token), AuditLog (IP), PhoneOtp (phone, IP)                                                                                                      | V                    |

**Data flows.** All data processing happens in the US.

```
Indian buyer --+                       +--> Razorpay (India, PA)    order/prefill email+phone; returns payment events (stored whole)
US buyer ------+--> Railway us-west2 --+--> Stripe (US)             customer_email, Connect metadata
(browser/app)  |   api/worker/Postgres +--> MSG91 (IN) / Twilio (US) phone + message text
               |   Redis/backups (US)  +--> AWS SES/SNS ap-south-1  email address + content  (Indian AND US recipients go via Mumbai)
               |                       +--> Expo push (US)          device token + text
               +--> Cloudflare edge (country/city headers only; no third-party geocoding)
```

**What crosses borders (V).**

- Indian personal data goes to the US (Railway).
- US personal data goes to India (SES Mumbai).
- Off-site backups, if enabled, would put US data in Mumbai.

**How the market is decided (V).**

- **Currency** comes from the venue's country (`commerce-currency.ts`).
- **Payment provider** comes from the booking's currency and country, and a mismatch is refused (`payment-provider.resolver.ts:82-101`).
- **Legal entity**: `legalEntityFor` maps INR to the India entity and USD or anything unknown to the US entity. Public pages deliberately say only "operated by DeepTrics LLC" until counsel answers `docs/compliance/LEGAL-REVIEW-QUESTIONS.md`.
- **Where country is stored**: `Booking`, `Event`, `Payment` and `Refund` have **no country column**. Country is derived from Venue, currency and Organization. There is no per-record data-region tag (V, from the PROD catalogue).

---

## 4. Compliance assessment by country

Status is as of 2026-11-12. "Required" means a law or contract in force or scheduled; "Recommended" means best practice.

### India

| Obligation                                                                                                                                                                                                                    | In force                   | Applies                                      | Status                                                                                                          | Type                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| IT Act s.43A + SPDI Rules 2011, rule 7 (transfer abroad needs equal protection, plus contract or consent)                                                                                                                     | **Now**, until 13 May 2027 | Likely                                       | Partly met. The privacy notice does not disclose US hosting or list sub-processors.                             | Required                                                 |
| CERT-In Directions 2022: report incidents within **6 h**; keep ICT logs 180 days **"within Indian jurisdiction"**                                                                                                             | **Now**                    | Likely                                       | **Not met.** No 6 h runbook. Logs are in Railway US with short retention (NV).                                  | Required; **counsel needed on log location**             |
| DPDP Act + Rules (G.S.R. 846(E)): notice, consent, security (Rule 6), breach to the Board within 72 h (Rule 7), 1-year log retention (Rule 8(3)), rights and 90-day grievances (Rule 14), parental consent under 18 (Rule 10) | **13 May 2027**            | Likely                                       | Partly met: consent versions exist. Missing: grievance officer, DSAR export, under-18 handling, retention jobs. | Required from 2027                                       |
| DPDP s.16 cross-border transfer (negative list)                                                                                                                                                                               | 13 May 2027                | Likely                                       | Lawful. No country is restricted (official notification: NV).                                                   | Required                                                 |
| Significant Data Fiduciary duties and possible localisation                                                                                                                                                                   | Only on notification       | Unlikely                                     | —                                                                                                               | —                                                        |
| Third Schedule 3-year inactivity erasure                                                                                                                                                                                      | ≥2 crore users only        | Unlikely                                     | —                                                                                                               | —                                                        |
| RBI 2018 storage circular + PA Master Directions 2025 + card-on-file tokenisation                                                                                                                                             | Now                        | Binds **Razorpay**; merchant only indirectly | We store no card or credential data (V). Webhook payloads with VPA and last-4 should be minimised.              | **Needs written confirmation from Razorpay and counsel** |

Sources: Rules [meity.gov.in PDF](https://www.meity.gov.in/static/uploads/2025/11/53450e6e5dc0bfa85ebd78686cadad39.pdf); [PIB](https://www.pib.gov.in/PressReleasePage.aspx?PRID=2190014); [RBI FAQ](https://www.rbi.org.in/commonman/english/scripts/FAQs.aspx?Id=2995); [RBI PA MD 2025](https://www.rbi.org.in/Scripts/BS_ViewMasDirections.aspx?id=12896); [CERT-In Directions](https://www.cert-in.org.in/PDF/CERT-In_Directions_70B_28.04.2022.pdf).

### United States

| Obligation                                                               | Applies  | Status                                                                                 |
| ------------------------------------------------------------------------ | -------- | -------------------------------------------------------------------------------------- |
| FTC Act s.5 (no deceptive privacy claims; reasonable security)           | Yes      | The policy must match practice: sub-processors and deletion scope.                     |
| State breach-notification laws (all 50 states, any company size)         | Yes      | **No breach runbook** (I).                                                             |
| TCPA prior express written consent for marketing SMS; CTIA and A2P 10DLC | Yes      | Consent is recorded with a version (V). A2P is still blocked (memory).                 |
| CAN-SPAM (physical address, opt-out within 10 days)                      | Yes      | NV for the address in marketing email.                                                 |
| PCI DSS SAQ A via Stripe Checkout/Elements (contractual)                 | Yes      | No card data stored (V).                                                               |
| CCPA/CPRA (>$26.6M revenue or 100k consumers) and other state laws       | Not yet  | Monitor thresholds. Texas: small-business exemption, but no selling of sensitive data. |
| COPPA                                                                    | Unlikely | The policy says the service is not for children. There is no age gate (V).             |
| DOJ bulk-data rule, 28 CFR 202                                           | No       | India and Singapore are not countries of concern.                                      |

Sources: [FTC Act](https://www.ftc.gov/legal-library/browse/statutes/federal-trade-commission-act); [CPPA threshold](https://cppa.ca.gov/regulations/cpi_adjustment.html); [FCC 1:1 rule removed](https://www.federalregister.gov/documents/2025/08/29/2025-16641); [CAN-SPAM](https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business); [DOJ rule](https://www.federalregister.gov/documents/2025/01/08/2024-31486).

### Canada (future)

- **PIPEDA:** accountability model, no localisation. Customers must be told that data is processed abroad.
- **Quebec Law 25, s.17:** a **privacy impact assessment before data leaves Quebec**, plus a written agreement. This is required before launching in Quebec.
- **Alberta PIPA:** notice when a provider outside Canada is used.
- **Breach reporting to the OPC:** where there is a real risk of significant harm, with breach records kept 24 months.
- **CASL:** applies to commercial messages.
- **C-27 died; C-36 was introduced in June 2026** and is not in force.

Sources: [OPC transfer guidance](https://www.priv.gc.ca/en/privacy-topics/airports-and-borders/gl_dab_090127/); [CAI Quebec](https://www.cai.gouv.qc.ca/protection-renseignements-personnels/information-entreprises-privees/utilisation-communication-renseignements-personnels); [C-36](https://www.parl.ca/legisinfo/en/bill/45-1/c-36).

**Needs counsel or a provider's confirmation**

1. Whether Razorpay requires India storage from the merchant (get it in writing).
2. Where CERT-In logs may be kept.
3. Which entity is the contracting seller per market (already open in `LEGAL-REVIEW-QUESTIONS.md`).
4. The text of the cross-border disclosure for India and Canada.
5. The Quebec privacy impact assessment.

---

## 5. Security and privacy findings

**No P0: nothing is exposed publicly and nothing is an active breach.**

| ID  | Sev    | Finding                                                                                                                                                                                                            | Evidence                                                                  |
| --- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| S1  | **P1** | Full Razorpay and Stripe webhook payloads kept forever, holding payer email, phone, VPA and card last-4                                                                                                            | V: PROD counts above; `razorpay-webhook.service.ts:92-100`                |
| S2  | **P1** | The app connects as the `postgres` **superuser**; it is the only login role. One SQL-injection or credential leak gives full control of the database.                                                              | V: `pg_roles`                                                             |
| S3  | **P1** | Backups live only on a Railway volume in the same project and region; off-site is OFF. Losing the project or region loses both the data and the backups.                                                           | V                                                                         |
| S4  | **P1** | Account deletion leaves personal data in: guest bookings under the same email, MarketingConsent email and phone, TicketInvite, Feedback, CrmLead, webhook payloads                                                 | V: `account-deletion.service.ts`                                          |
| S5  | **P1** | No retention purge except refresh tokens. OTP, email codes, reset tokens, notifications, webhooks and audit IPs grow forever.                                                                                      | V: `apps/worker/src/main.ts:596-667`; PROD OTP rows go back to 2026-10-07 |
| S6  | **P1** | No platform grievance officer or privacy contact. The privacy policy draft still has a "[privacy email]" placeholder and does not disclose US hosting or the sub-processors (Railway, AWS, Twilio, MSG91, Sentry). | V: `privacy/page.tsx`, `docs/commercial/PRIVACY-POLICY.md`                |
| S7  | **P1** | No incident-response runbook that meets CERT-In 6 h, the DPDP 72 h (2027) and US state deadlines. CERT-In log location is unresolved.                                                                              | I (no doc found); counsel                                                 |
| S8  | P2     | Tenant isolation relies on each service calling `assertMember`; there is no row-level security or central guard. No concrete IDOR in about 10 routes sampled.                                                      | V: `org-access.service.ts:89`; 0 tables with RLS                          |
| S9  | P2     | PAN, GSTIN and EIN stored in plaintext, while bank numbers are encrypted                                                                                                                                           | V                                                                         |
| S10 | P2     | The exception-filter redaction misses email, phone and OTP keys                                                                                                                                                    | V: `all-exceptions.filter.ts:42`                                          |
| S11 | P2     | No self-service data export (DSAR); requests go by contact form                                                                                                                                                    | V                                                                         |
| S12 | P2     | Sentry DSN not set in PROD, so there is no error monitoring for api and worker. The scrubbing code exists and is good.                                                                                             | V                                                                         |
| S13 | P2     | DB and Redis connections have no TLS enforced. This relies on the private network.                                                                                                                                 | V config; I safe                                                          |
| S14 | P3     | No age gate; `ageLimit` is display-only (DPDP under-18 rules from 2027)                                                                                                                                            | V                                                                         |
| S15 | P3     | `data_checksums=off` on PROD Postgres                                                                                                                                                                              | V                                                                         |
| S16 | P3     | Deletion audit rows keep IP and user agent indefinitely                                                                                                                                                            | V                                                                         |
| S17 | P3     | PROD may record PRIVACY v1 consent while the site shows v2                                                                                                                                                         | NV (docs claim)                                                           |

**Positives (V)**

- No card data stored.
- bcrypt for credentials.
- AES-GCM for bank numbers and MFA secrets.
- Postgres and Redis are private.
- Sentry scrubbing and `sendDefaultPii=false` in code.
- OTP and SMS text logged only in dev.
- No analytics or trackers.
- No committed secrets (only `*.example` files).
- Per-market provider routing that refuses mismatches.
- Consent rows carry the policy version.

---

## 6. Database architecture options

Costs are monthly infrastructure only, **I**. They are estimates from Railway usage pricing at today's size, not quoted.

|                        | **A. One shared DB**                                                                    | **B. Separate India + USA databases**                                                                                              | **C. Global identity + regional data**                          |
| ---------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Compliance today       | Lawful with the controls in sections 4–5                                                | Lawful; not required by any law in force                                                                                           | Lawful; ready if a localisation trigger fires                   |
| Security               | One blast radius; needs least-privilege roles                                           | Smaller blast radius per region; two of everything to secure                                                                       | Identity concentrated; regional data separated                  |
| Latency                | India users go to US West, about 220–280 ms per round trip (I). Already the case today. | Best for each market, if compute also moves                                                                                        | Best for each market                                            |
| India hosting          | —                                                                                       | **Railway has no India region (I).** Needs AWS RDS Mumbai or similar, plus app compute there. Cross-cloud DB calls are not viable. | Same constraint                                                 |
| Operational complexity | Low (today)                                                                             | High: two deploys, migrations, backups, admin and finance reporting across databases, cross-market organizers                      | Highest: routing layer, user lookup across regions, consistency |
| Migration effort       | None                                                                                    | 4–8 weeks; payments, payouts and finance read models need to be split                                                              | 8–14 weeks; builds on B                                         |
| Est. monthly cost      | About $40–90 now (all services). +$5–20 for off-site S3 and object storage.             | About 2x: +$60–150 (second stack, or RDS Mumbai at about $25–60 plus compute)                                                      | +$80–200, plus engineering time                                 |

---

## 7. Recommended target architecture

**Now: Option A, hardened.**

1. Use **least-privilege database roles**: an `app` role without superuser or DDL; a separate migration role; a read-only role for audits.
2. Turn **off-site backup ON**. Choose a deliberate region: Mumbai holds US data too, which is lawful. Use SSE-KMS.
3. **Minimise webhook payloads**: store only the ids and status the code reads. Purge raw payloads after about 180 days. Keep at least 1 year of order and payment events for DPDP Rule 8(3).
4. Run **retention jobs**, extend the **deletion scope**, add a **DSAR export**, publish a **grievance officer**, and disclose **sub-processors and cross-border processing**.
5. Add a **`dataRegion` tag** (IN/US/CA) on User, Organization, Event and Booking, derived server-side. This makes later partitioning a data move, not a redesign.

**Later: move to Option C only on a trigger.**

- MeitY restricts the US under s.16.
- The company is notified as a Significant Data Fiduciary.
- Razorpay or counsel requires India storage.
- A Quebec privacy impact assessment rejects US hosting.
- An enterprise or government contract demands it.
- India latency becomes a measured conversion problem. If latency is the only driver, moving the single stack to **Singapore** is a cheaper alternative to splitting (I).

---

## 8. Prioritised roadmap (implementation needs your approval)

| Phase                      | Items                                                                                                                                                                           | Effort                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| **0: this week (no code)** | Ask counsel the 5 questions in section 4. Ask Razorpay for written confirmation of merchant storage obligations. Name a grievance officer and privacy email.                    | Owner                    |
| **1: 2–3 weeks**           | S2 database roles; S3 off-site backup; S1 webhook minimisation and purge; S7 incident runbook (CERT-In 6 h); S6 privacy-notice update (sub-processors, US hosting)              | Engineering plus owner   |
| **2: before 13 May 2027**  | S4 deletion scope; S5 retention jobs; S11 DSAR export; S14 age gate and parental-consent flow; S9 tax-id encryption; S10 redaction; S12 Sentry DSN; 1-year log retention (DPDP) | Engineering              |
| **3: before Canada**       | Quebec privacy impact assessment; CASL; Canadian supplement; `dataRegion` tag (S8 row-level security considered at the same time)                                               | Engineering plus counsel |
| **4: on trigger**          | Option C regional stores                                                                                                                                                        | Planned when triggered   |

---

## 9. Cost implications

| Item                                                                                                                                     | Monthly cost (I)                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Phase 1 additions: S3 off-site (a few hundred MB), KMS key, log shipping for 180-day / 1-year retention (e.g. Better Stack, Axiom or S3) | About **$5–30**                                       |
| Moving the whole stack to Singapore                                                                                                      | About $0 extra                                        |
| Separate India stack (B)                                                                                                                 | About **+$60–150**, plus ongoing engineering overhead |
| Regional architecture (C)                                                                                                                | About **+$80–200**, plus significant engineering      |

**NV:** current actual Railway spend. The project token cannot read billing.

---

## 10. Production readiness

**CONDITIONAL GO** to continue on a single shared database for India and the USA.

**Conditions before meaningful scale or marketing**

- Phase 1: S1, S2, S3, S6 and S7.
- Counsel's answers on the CERT-In log location and the RBI merchant obligations.

**NO-GO** for a Canada or Quebec launch until the Quebec privacy impact assessment and the Canadian notice exist.

**No finding requires stopping current operations.**
