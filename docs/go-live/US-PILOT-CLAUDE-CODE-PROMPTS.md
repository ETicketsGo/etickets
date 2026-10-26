# US pilot go-live: Claude Code prompts

Written 13 Oct 2026 from a review of the codebase, qa.eticketsgo.com and organizer-qa.eticketsgo.com.

**Goal:** take real money for US diaspora and community events (USD, Stripe), starting in Boise.
India cinema stays built but parked. Nothing in this list adds a new feature.

## How to run these

- Run one prompt per Claude Code session, on its own branch, and merge one PR per prompt.
- Order matters: run 0 first, then 1 to 8 in order. Prompts 9 and 10 touch production, so stay at the keyboard for those.
- Every prompt ends with `npm run verify`. Do not merge on red.
- Paste each prompt exactly as written. Claude Code can also read this file: "Do prompt 3 in docs/go-live/US-PILOT-CLAUDE-CODE-PROMPTS.md".

---

## Prompt 0: Scope freeze (add to CLAUDE.md once)

```
Add a section to the root CLAUDE.md (create it if missing) titled "Current focus: US pilot".
It must say:
- The goal is the first 10 real paid US events (USD, Stripe), not new features.
- Do not add features, modules, flags, locales or dependencies unless a task explicitly asks for one.
- India cinema, AI, offline check-in, wallet passes and web push are parked. Do not change them except to keep tests green.
- Money rules are non-negotiable: integer minor units, immutable fee snapshots, idempotent payments, no double-sold seats.
- Every change ships with a test, and `npm run verify` must pass before a PR is opened.
- Never run destructive seeds or migrations against QA, UAT or production without asking me first
  (see VIJAYAWADA-PILOT-READINESS-REPORT.md section 0 for why).
Keep the section under 25 lines. Show me the diff before committing.
```

## Prompt 1: Block USD checkout on the event page when the organizer can't take payment (money, highest priority)

```
Bug: a buyer can select tickets for a paid USD event and reach "Continue to payment" even when
the organizer has not finished Stripe Connect onboarding. The organizer payouts page says
"You cannot sell paid tickets in this currency until payout setup is finished", and the hard stop
seems to happen only at payment time (apps/api/src/payments/payments.service.ts, around the
`chargesEnabled` check near line 321). Repro on QA: organizer "Bengaluru Live", event
"Riverbend Jazz Night" (/events/riverbend-jazz-night-6a61a6). 2 x Open seating shows $59.15
and the Continue button is enabled.

Do this:
1. Trace exactly what happens today when that buyer clicks Continue to payment, and write it down
   in the PR description before changing anything.
2. Make one source of truth for "can this event take paid orders in its currency". Reuse
   `canSellPaidTickets` from apps/api/src/payments/connect/organizer-connect.service.ts, and see
   the note in apps/api/src/organizations/organizer-actions.ts about the two questions disagreeing.
3. Expose it on the public event and show payloads, and also enforce it when a booking or hold is
   created, so no inventory is held for an order that can never be paid.
4. Storefront: paid ticket types show "Tickets not on sale yet" and cannot be added. Free tickets still work.
5. Organizer console: the event's Manage page and the overview "Needs action" list say this event
   is not selling, and why.
6. Tests: an API unit test for the gate, an integration test that booking creation is refused with a
   coded error, and a Playwright check that the button is disabled.
Run `npm run verify`.
```

## Prompt 2: Settlement table "Fees" and "Net" don't reconcile (money)

```
On organizer-qa /organizer/payouts the Settlements table shows: gross 1,598, fees 52.36,
refunds 0, net 1,598. To an organizer that reads as a calculation bug.
apps/api/src/payouts/currency-settlement.calculator.ts computes
net = gross - discount - organizerFee - refund, and the column is rendered in
apps/organizer-web/app/organizer/payouts/page.tsx (key 'fees').

1. Find out what the Fees column actually shows: buyer-paid fees, total fees or organizer fees.
   Confirm it against that settlement's bookings in QA (read only).
2. If the maths is right and the label is wrong: show "Your fees" (organizer-borne, the amount
   subtracted) and "Buyer-paid fees" separately, so that gross - discount - your fees - refunds = net
   is visibly true on every row. Use the same wording as the overview's "Sales and proceeds" panel.
3. If the maths is wrong: stop and tell me before changing anything. Do not alter stored payout rows.
4. Add a test that renders a row where buyer fees are greater than 0 and organizer fees are 0, and
   asserts the visible numbers reconcile.
Run `npm run verify`.
```

## Prompt 3: React hydration error #418 on the storefront

```
Every customer-web page I checked on qa.eticketsgo.com logs "Minified React error #418"
(hydration text mismatch), including the home page, an event page and the seat page
/shows/[id]. The likely cause is dates and times or "today"-relative text formatted differently
on the server and in the browser (timezone or locale), or random or Date.now() values in render.

1. Reproduce it locally with a production build (`next build && next start`) and the dev overlay,
   and find every component that produces it.
2. Fix it at the root: format times with an explicit IANA timezone (the venue's) and an explicit
   locale on both server and client, and keep client-only values out of the first render.
   Do not hide it with suppressHydrationWarning unless it really is unavoidable, and say why if you do.
3. Add a Playwright test that loads home, an event page and a show page and fails on any console error.
Run `npm run verify`.
```

## Prompt 4: Keep test and demo data off the public storefront

```
The public QA storefront lists records like "Pilot Free Community Day 202610092123",
venue "Pilot Boise 10092039", "Pilot Currency Film 10092038", a "Test" movie genre, and
descriptions containing "QA demo content" and "Demo key: qa-demo/...". The organizer "Bengaluru Live"
owns Boise events. Production must never show anything like this.

1. Find how test, pilot, certification (QA Cert Concert *), e2e (Demo Arena E2E *) and K-TEST records
   are created. Add an explicit boolean on Organization (or Event), e.g. `isTestData`, set by those
   scripts, rather than matching names.
2. Public discovery, search, movies, genres, sitemap and city counts exclude test data when
   APP_ENV=production. In QA they stay visible but show a small "Test" badge.
3. Add a production boot or readiness check that warns if any published, public, non-test event's
   title matches /pilot|qa cert|k-test|e2e|test/i.
4. Migration is additive only. Do not delete any data.
Run `npm run verify`.
```

## Prompt 5: Small storefront and console UI fixes

```
Fix these four, one commit each:
a) Seat map (/shows/[id]): seats that can't be sold (for example a seat category blocked by a
   regulatory rule, like row P "Platinum Executive" on QA) render as blank boxes with no number,
   and the legend only has Available, Selected and Held. Number them, style them as unavailable,
   add "Not on sale" to the legend, and give screen readers the reason.
b) Cinema launch-readiness page (/organizer/cinemas/[id]/readiness): "Your ticket prices" repeats
   Regular/Recliner/Platinum once per show (25 times) with no show label. Show each distinct price
   set once, with the shows it applies to.
c) Onboarding (/organizer/onboarding): the header says "3 of 4 complete, 75%" but lists 5 steps,
   4 of them done. Derive the count from the same list that renders, and treat optional steps consistently.
d) "Partly selling: Telangana pricing rules not configured" appears on an event whose first venue is in Boise.
   Name the venue or show that the message is about.
Add or adjust a unit test for each. Run `npm run verify`.
```

## Prompt 6: Clean US demo organizer (for showing real prospects)

```
Create an idempotent, NON-destructive script `npm run db:demo-us` (apps/api/prisma) that creates
or updates one realistic demo organization for sales demos, separate from all QA fixtures:
- Organization "Treasure Valley Telugu Association (Demo)", USD, Boise, ID, marked isTestData=true
  (from prompt 4) so it never appears in production discovery.
- 3 events: a Sankranti cultural evening (GA + family pass), a paid community concert (reserved
  seating at an existing Boise space) and a free volunteer meetup. Realistic descriptions, no
  "QA demo" text, sensible prices, refund window set.
- An owner and a check-in staff user. Print their emails, but no passwords. Passwords come from
  env vars that the script requires.
Running it twice must change nothing. Add a test for idempotency. Document it in docs/commercial/DEMO-ACCOUNTS.md.
Do not run it against QA. I will.
```

## Prompt 7: Make the README tell the truth

```
README.md is out of date: "Known MVP limitations" says payments are a mock provider and that
Stripe/Razorpay are stubs, but live Razorpay is wired (see docs/INDIA_LAUNCH_READINESS.md),
and the milestone list stops at M5. Rewrite only the Status, Known limitations and Next steps
sections to match the code today. Link to docs/go-live/REGISTER.md and this prompts file
instead of duplicating them. Keep it short. Verify every claim against code or docs and cite the file
in the PR description. No other files.
```

## Prompt 8: Movies entry point only where movies exist

```
The storefront title says "Book tickets for movies...", but there is no Movies link in the header
or bottom nav (apps/customer-web/components/bottom-nav.tsx, header.tsx). Users only reach
/movies by typing the URL. Show a Movies entry in header and bottom nav only when the selected
city or market has at least one bookable show. Otherwise hide it, and drop "movies" from the
<title> and meta description for US markets. Add a test for both cases. Run `npm run verify`.
```

## Prompt 9: US production readiness audit (read only)

```
Read-only audit. Do not deploy, change config or create anything. Produce
docs/go-live/US-READINESS-<date>.md in the same matrix style as docs/INDIA_LAUNCH_READINESS.md,
for the US/USD path only:
- Stripe: live keys present in prod (names only, never values), Connect onboarding flow works,
  webhook endpoint registered and signature verified, USD checkout path resolves to Stripe.
- Email (SES) live and domain verified, Sentry DSN, managed secret store, CORS, production-hardening gate.
- Database: latest verified backup and restore tested (this blocked the 5 Oct deploy). Show the evidence.
- Business details and legal pages: which fields are still null and which pages are still drafts.
- Prompts 1 to 5 merged and deployed to QA.
End with a list of items for a person to do (accounts, legal, decisions) and a list of items for
engineering, each with the exact env var or file involved.
```

## Prompt 10: Production deploy and first real transaction (stay at the keyboard)

```
Only after prompt 9 shows no engineering blockers. Follow docs/FIRST_PRODUCTION_TRANSACTION_RUNBOOK.md
and docs/DEPLOYMENT-GUIDE.md. Ask me for approval before every step that changes production.
1. Confirm a fresh verified backup exists. Stop if it doesn't.
2. Deploy main to production through the normal pipeline, run `npm run verify:deploy`, and check
   /api/health and /api/ready.
3. Smoke-test the storefront and organizer console with read-only checks: no console errors, no test data visible.
4. Guide me (do not do it yourself) through one real $1 USD purchase on a hidden test event owned by
   my own organization with Stripe live, then verify: webhook received, booking CONFIRMED, ticket
   issued, email sent, fee snapshot correct, settlement row correct. Then refund it and verify the refund.
5. Write docs/go-live/FIRST-US-TRANSACTION-<date>.md with evidence (IDs, not secrets).
```

---

## For you, not Claude Code

- Stripe live account and Connect platform profile in the name of the right legal entity.
- An immigration attorney consult before ETicketsGo or DeepTrics earns money or you take an active operating role.
- A lawyer to finalize terms, privacy, refund policy and organizer agreement (all four are still drafts).
- Fill in business details (9 null fields) and the support contact.
- Line up 3 friendly organizers for the first events, and be at the door for each one.

---

# India track (prompts 11–16)

Run after prompts 0–5, since the hydration, test-data and seat-map fixes apply to India too.
Production deploy and backup are shared with prompts 9–10. Most India blockers are decisions and
paperwork (GST answers, DLT sender header, legal pages), so these prompts prepare and verify. They
never switch anything on by themselves.

## Prompt 11: Make GST money code safe before anyone activates it

```
Before any GST rule is activated in production, fix the two known issues in the fee engine
(listed under "ENGINEERING GAPS" in docs/INDIA_LAUNCH_READINESS.md):
1. calculateFees accepts `taxRules` and would charge inclusive tax twice
   (totalMinor = netSubtotal + customerFee + taxMinor, instead of using taxAddedMinor), and throws on
   banded rules because it doesn't forward admissionLines. No production caller passes taxRules
   today. Remove taxRules from FeeCalcInput (preferred) or fix it to use taxAddedMinor. Prove
   PricingService.quote is the only path that rates tax.
2. Fee bands have gaps (Rs 199.01–199.99, and the same at 499 and 999) that fall back to the lower band.
   Make the bands contiguous using half-open ranges, so every paise value maps to exactly one band.
   Keep today's charged amounts unchanged for every whole-rupee subtotal.
3. Add property-style tests over a range of subtotals (0 to 5,000 rupees, in paise steps where
   practical): exactly one band matches, total = subtotal + fees + added tax, and inclusive tax is
   never added on top.
Do NOT activate any TaxRule or change any rate. This is shared money code, so put a clear
before/after table of sample orders in the PR description. Run `npm run verify`.
```

## Prompt 12: GST activation switchboard, driven by my decisions

```
Read docs/INDIA_GST_BUSINESS_DECISIONS.md (Q1–Q12). Create
docs/go-live/INDIA-GST-DECISIONS-TO-CONFIG.md, a table mapping each question to the exact
setting, table row, env var or code path it controls, the current production value, and what
changes for a Rs 100, 250 and 500 ticket under each possible answer.
Then add a read-only command `npm run db:gst-status` (apps/api) that prints, for any environment:
active and draft TaxRule rows, the GST registration state, the fee-tax mode (inclusive/added) and
who remits admission GST, and refuses to report "ready" while Q1, Q3 or Q10 are unanswered.
Do not activate anything and do not write to the database. Run `npm run verify`.
```

## Prompt 13: SMS / DLT: get templates ready for registration and prove MSG91 end to end

```
Context: India SMS goes through MSG91. DLT Principal Entity registration is approved on STPL. The
sender header "ETKTGO" has been rejected 3 times, so the header must be configurable, never hard-coded.
1. Inventory every SMS the platform can send (OTP, booking confirmation, guest booking access,
   cancellation and refund, check-in, organizer alerts). Update docs/INDIA_DLT_TEMPLATE_INVENTORY.md
   with, per message: the template key, category (transactional / service-implicit / OTP), exact text
   in DLT variable syntax ({#var#}), max rendered length, and the env var that holds its DLT template ID.
   Keep each template short, brand-named ("ETicketsGo") and free of URLs where possible, because DLT
   scrubbing rejects unregistered links.
2. Make sure the sender header, PE ID and every template ID come from env vars, and that a missing
   value fails closed with a visible error naming the key (as the readiness doc says it does now).
   Add a test that fails if any SMS template key has no env var mapping.
3. Add a read-only `npm run sms:status` that lists which template IDs are set, but not their values.
4. Add a guarded dev or QA command that sends one OTP through MSG91 to a number passed on the command
   line, and only when SMS_PROVIDER=msg91 and APP_ENV is not production.
5. Decision for me, don't decide it yourself: whether GUEST_BOOKING_ACCESS (a bearer link) may go by SMS.
   Default it to email-only and document the trade-off.
Run `npm run verify`.
```

## Prompt 14: Mobile number at guest checkout for India

```
Indian buyers expect tickets on their phone. At guest checkout (apps/customer-web/components/
guest-buyer.tsx and the show/event checkout pages) add a mobile number field when the event's market is
India: +91 prefix, 10 digits validated with the shared Zod schema in @eticketsgo/validation, and
stored on the booking contact. Required for India and hidden for US/CA. Email stays required everywhere.
Until DLT is live (SMS_PROVIDER=log), the number is stored but nothing is sent, and no checkout or
confirmation copy may promise an SMS.
Privacy: mask it in admin and organizer views except where a booking must be looked up, and audit full
reads the same way bank numbers are. Tests: validation, market switch, masking. Run `npm run verify`.
```

## Prompt 15: Cinema regulatory readiness for the Vijayawada pilot (no activation)

```
On QA, the pilot cinema "ETG Vijayawada Multiplex (QA pilot)" is blocked: seat category
"Platinum Executive" has no regulatory seat class (25 of 25 shows), no AP pricing order applies to
its classification (multiplex, ac, municipal corporation), so checkout holds the booking fee at 0.
AP has 41 DRAFT / 0 ACTIVE policy rows, TG has 2 DRAFT, and the source documents are UNREVIEWED
(see VIJAYAWADA-PILOT-READINESS-REPORT.md and docs/regulatory/).
1. Read apps/api/src/cinemas/cinema-compliance.service.ts and
   apps/api/src/pricing/cinema-policy/sale-eligibility.ts. Write
   docs/india-pilot/VIJAYAWADA-ACTIVATION-CHECKLIST.md listing exactly which seat-class mappings and
   which policy rows must move from DRAFT to ACTIVE for this cinema to sell every category with the
   correct booking fee, and which government order and clause each row depends on.
2. For each of those rows, show the figure and the source document, and mark it "needs human
   review". You must not invent or infer any rupee amount. If the source is missing, say so.
3. Make sure the organizer UI lets an owner map a seat category to a regulatory seat class
   (the "Map seat classes" link) and that the readiness page updates afterwards. Fix it if broken,
   with a test.
4. Do NOT activate any policy row or change any price. I'll do that after I review the figures.
Run `npm run verify`.
```

## Prompt 16: First real INR transaction (stay at the keyboard)

```
Only after prompt 10's production deploy and backup are done, and after I confirm: GST answers
(or an explicit decision to launch with tax 0 on a non-cinema event), business details filled,
legal pages approved.
Follow docs/FIRST_RAZORPAY_PAYMENT_RUNBOOK.md and docs/FIRST_PRODUCTION_TRANSACTION_RUNBOOK.md.
Ask me for approval before every production change.
1. Read-only pre-check: Razorpay live keys present (names only), webhook endpoint live and refusing
   bad signatures, business details non-null, legal pages not marked draft, `db:gst-status` output.
2. Guide me (do not do it yourself) through one real small INR purchase on a hidden event owned
   by my own organization. Verify: webhook signature accepted (this is the only proof the webhook
   secret matches), booking CONFIRMED, ticket issued, email sent, fee and tax snapshot correct,
   settlement row correct. Then refund it and verify refund.processed handling.
3. Write docs/go-live/FIRST-INR-TRANSACTION-<date>.md with evidence (IDs, not secrets).
```

## Later, after the first India transaction: Telugu and Hindi

Deliberately parked by prompt 0's freeze. When you're ready: "Add `te` and `hi` locales to
@eticketsgo/i18n for the customer storefront, checkout and ticket emails only. Machine-draft the
strings, mark them for native review, and keep the fallback to English."
