# VP Global Expansion — International Strategy

Country-by-country evaluation and rollout. The platform is **already multi-country**
(payments span India/US/CA/AU/UK; env-scoped config + promotion enable clean
per-market rollout), so expansion is a **commercial + compliance** exercise, not a
re-platforming. Pairs with the [GTM Strategy](../gtm/GO-TO-MARKET-STRATEGY.md).

## Priority & sequencing

| Priority             | Market                           | Rationale                                                             |
| -------------------- | -------------------------------- | --------------------------------------------------------------------- |
| **1 (beachhead)**    | 🇮🇳 India                         | Huge volume, incumbent fee pain, Razorpay native, WhatsApp-first      |
| **1 (co-beachhead)** | 🇬🇧 UK or 🇦🇺 Australia            | English, Eventbrite fatigue / low-fee demand, Stripe/Square           |
| **2**                | 🇦🇺 Australia / 🇬🇧 UK (the other) | Same playbook; ride content + references                              |
| **3**                | 🇺🇸 USA + 🇨🇦 Canada               | Largest TAM but crowded/expensive; enter with proof                   |
| **4**                | 🇦🇪 Middle East (UAE-first)       | High-growth events/entertainment; requires local acquiring/compliance |
| **5**                | 🇪🇺 Europe (EU)                   | Fragmented, GDPR + local methods; enter selectively later             |

Discipline: **prove unit economics in the beachhead before opening the next
market**; never spread thin.

---

## Per-country evaluation

### 🇮🇳 India — Priority 1 (beachhead)

- **Legal:** DPDP Act (data protection); GST on fees + invoices; entity/GST
  registration; RBI-compliant payments via licensed PA (Razorpay). Nodal/settlement
  norms.
- **Payments:** Razorpay (UPI/cards/netbanking/wallets) primary, Stripe failover.
- **Localization/languages:** English + Hindi first; regional languages later;
  WhatsApp-first comms (built-in).
- **Currency:** INR.
- **Competition:** BookMyShow, District (Zomato), Townscript, Insider, Zoho Backstage.
- **GTM:** campus ambassadors + founder-led cinema/promoter deals + Razorpay co-marketing.
- **Partnerships:** Razorpay, universities, regional multiplexes, promoters, religious trusts.
- **Rollout:** live now; scale via pilot → GA.
- **Risks:** incumbent bundling; UPI dispute handling; regional-language support cost.

### 🇬🇧 UK — Priority 1/2

- **Legal:** UK GDPR + PECR (marketing consent); VAT on fees; ICO registration;
  Strong Customer Authentication (SCA/3DS) — handled by Stripe.
- **Payments:** Stripe primary, PayPal.
- **Localization/languages:** English; £ formatting; SCA-compliant checkout.
- **Currency:** GBP.
- **Competition:** Eventbrite, DICE, Skiddle, Ticket Tailor, Fatsoma; Ticketmaster/See Tickets (enterprise).
- **GTM:** product-led + fee-savings content + SU (students' union) + comedy/music partnerships.
- **Partnerships:** Stripe, universities/SUs, comedy clubs, grassroots promoters.
- **Rollout:** fast-follow beachhead; content + self-serve.
- **Risks:** DICE brand in music; Eventbrite incumbency; SCA drop-off (mitigated by wallets).

### 🇦🇺 Australia — Priority 1/2

- **Legal:** Privacy Act (APPs); GST; consumer law (refunds); Square/Stripe compliant.
- **Payments:** Stripe primary, Square, PayPal; (BECS/PayTo future via providers).
- **Localization/languages:** English; A$; GST-inclusive display.
- **Currency:** AUD.
- **Competition:** Humanitix, TryBooking, Moshtix, Eventbrite; Ticketek (enterprise).
- **GTM:** product-led + nonprofit/education angle; Square co-marketing; community/sports.
- **Partnerships:** Square, schools/universities, sports clubs, community orgs.
- **Rollout:** fast-follow; low-fee positioning.
- **Risks:** Humanitix goodwill (donation model); single-market loyalty.

### 🇺🇸 USA — Priority 3

- **Legal:** state privacy patchwork (CCPA/CPRA etc.); sales-tax nexus complexity;
  1099-K/settlement reporting; ADA accessibility for public events.
- **Payments:** Stripe primary, PayPal, Square.
- **Localization/languages:** English (+ Spanish surfaces later); US$.
- **Currency:** USD.
- **Competition:** Eventbrite, DICE, Ticketleap, Universe, Luma; Ticketmaster/AXS/SeatGeek/Cvent (enterprise).
- **GTM:** reference-led + partnerships (Stripe, campuses, PCOs); paid content after ROI proven.
- **Partnerships:** Stripe, universities, conference producers, comedy circuits, indie cinemas.
- **Rollout:** enter after beachhead proof; wedge segments first.
- **Risks:** high CAC, crowded; tax complexity; enterprise incumbency.

### 🇨🇦 Canada — Priority 3

- **Legal:** PIPEDA (+ Quebec Law 25); GST/HST/PST; bilingual (EN/FR) expectations.
- **Payments:** Stripe primary, PayPal; Interac (future via provider).
- **Localization/languages:** English + **French (Quebec)**; C$.
- **Currency:** CAD.
- **Competition:** Eventbrite, Showpass, DICE; Ticketmaster (enterprise).
- **GTM:** ride US content + Canadian references; bilingual support.
- **Partnerships:** Stripe, universities, community/sports, festivals.
- **Rollout:** with/after US.
- **Risks:** bilingual + Quebec compliance; smaller TAM.

### 🇦🇪 Middle East (UAE-first) — Priority 4

- **Legal:** UAE PDPL; VAT; local entity/free-zone; content/event permits; possible
  data-residency; local acquiring often required.
- **Payments:** Stripe (where supported) + **local acquirer/gateway** (e.g. Network
  International/Telr/PayTabs) — add via the provider abstraction when prioritized.
- **Localization/languages:** English + **Arabic (RTL)**; AED.
- **Currency:** AED (+ SAR later).
- **Competition:** Platinumlist, Virgin Tickets, 800tickets, regional players.
- **GTM:** partnership + enterprise/government-led; premium events/entertainment.
- **Partnerships:** local acquirers, malls/cinemas, tourism/event authorities.
- **Rollout:** later; requires local payment + compliance build.
- **Risks:** local acquiring + entity setup; RTL/Arabic localization; permit regimes.

### 🇪🇺 Europe (EU) — Priority 5

- **Legal:** GDPR (strict), local VAT (OSS), SCA/PSD2, country-specific consumer law.
- **Payments:** Stripe (SEPA, iDEAL, Bancontact, giropay, etc. via provider).
- **Localization/languages:** multi-language (DE/FR/ES/NL…); €.
- **Currency:** EUR (+ local).
- **Competition:** Eventbrite, DICE, Eventix, Ticketswap, See Tickets, local leaders.
- **GTM:** enter selectively (one country) with local partner; not a broad push.
- **Rollout:** last; heavy localization + compliance.
- **Risks:** fragmentation; language + local-method breadth; strong local incumbents.

---

## Cross-market summary

| Market    | Currency | Primary payments        | Key language(s) | Priority | First motion                             |
| --------- | -------- | ----------------------- | --------------- | -------- | ---------------------------------------- |
| India     | INR      | Razorpay                | EN/HI           | 1        | Ambassadors + cinema/promoter + Razorpay |
| UK        | GBP      | Stripe/PayPal           | EN              | 1/2      | PLG + fee content + SUs                  |
| Australia | AUD      | Stripe/Square/PayPal    | EN              | 1/2      | PLG + nonprofit/edu + Square             |
| USA       | USD      | Stripe/PayPal/Square    | EN(/ES)         | 3        | References + partnerships                |
| Canada    | CAD      | Stripe/PayPal           | EN/FR           | 3        | With US; bilingual                       |
| UAE (ME)  | AED      | Stripe + local acquirer | EN/AR(RTL)      | 4        | Partnerships + enterprise/gov            |
| EU        | EUR      | Stripe (SEPA/local)     | multi           | 5        | Selective + local partner                |

## Rollout plan (playbook per market)

1. **Enable:** confirm payment routing + config in the target env; set fee mode +
   currency norms; localize currency/tax display.
2. **Comply:** privacy registration, tax/receipts, consent (marketing), data-residency
   if required.
3. **Seed:** recruit 5–10 local reference organizers (partner/ambassador-led).
4. **Prove:** hit local activation + payment-success + payout SLAs; 2–3 case studies.
5. **Scale:** self-serve + content + partnerships; measure CAC payback before spend.
6. **Localize deeper:** language, local payment methods, region-specific receipts.

## Risk register (top)

| Risk                        | Markets         | Mitigation                                                             |
| --------------------------- | --------------- | ---------------------------------------------------------------------- |
| Local acquiring/entity gaps | ME, parts of EU | Add local provider via abstraction; partner/entity setup before launch |
| Tax/receipt compliance      | all             | Per-region receipts + tax-config roadmap; local accounting partner     |
| Data residency/privacy      | EU, ME, gov     | Config + hosting posture per requirement; DPAs                         |
| Language/RTL                | ME, EU          | Prioritized localization; Arabic RTL for ME                            |
| High CAC / incumbents       | US, EU          | Beachhead-first discipline; partnerships; references before paid       |
| Spreading thin              | all             | One-market-at-a-time gate tied to unit economics                       |

**Bottom line:** capability is global; **go deep in India + one English market,
fast-follow the other English markets, then US/CA, and treat ME/EU as
partnership-gated later plays.**
