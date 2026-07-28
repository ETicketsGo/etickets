# ETicketsGo — International Readiness

State of multi-country/multi-currency support and the roadmap for global expansion.
The **money core is international-ready by design**; the remaining items are wiring and
market-specific features best added when a concrete non-India market is committed.

## Ready today (verified)

- **Integer minor units everywhere** — all money is `Int` minor units; no floats. The
  hardest thing to retrofit is already correct.
- **Currency per record** — `Booking.currency`, `TicketType.currency`, `Payment.currency`
  (default INR, but the column flows through).
- **Multi-country / multi-provider routing** — `payment-routing.selectRoute` +
  `selectMerchant` key on `(env, country, currency, method)`; providers declare served
  currencies (Razorpay INR; Stripe/PayPal/Square multi-currency).
- **Country-aware booking references** — `ETG-<ISO3>-<YEAR>-<SEQ>` (IND/GBR/USA/AUS/UAE).
- **Fee calculator** now carries the booking currency through to its result (Phase 2).
- **Payment routing** now receives the venue country at intent creation (Phase 2).

## Follow-ups (documented, add when a market lands)

| Area                        | Current                                                                                       | When needed                                             | Action                                                                                                                                 |
| --------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **Country representation**  | `Venue.country` is free-text (e.g. "India"); routing/merchant tables expect ISO-3166 alpha-2. | Before a 2nd market's country routing works end to end. | Normalize `Venue.country` to alpha-2 at write time (validate new venues; migrate existing when a non-IN market launches).              |
| **Fee tiers per currency**  | `DEFAULT_FEE_TIERS` are ₹-denominated; the calculator accepts `input.tiers`.                  | Charging in non-INR.                                    | Supply currency-specific tiers via the existing `tiers` seam / fee rules.                                                              |
| **Timezones**               | `EventSession.startsAt` is UTC; display helpers default to `en-IN`; no `timezone` field.      | Showing correct local showtimes across markets.         | Add an optional IANA `timezone` to Venue/Session and format with it; make the display locale a parameter.                              |
| **Tax (GST/VAT/sales tax)** | `tax()` report is honestly stubbed (`taxModelled:false`); no tax fields.                      | VAT/GST/sales-tax markets.                              | Add a `taxMinor` snapshot column + a pluggable rate resolver; the reporting stub already has the seam. Do **not** build speculatively. |
| **Localization (i18n)**     | Inline English copy; `Intl` used for money/dates.                                             | Non-English markets.                                    | Introduce a string-extraction layer (e.g. next-intl) then. English-speaking markets (US/CA/AU/UK) work today.                          |
| **Regional feature flags**  | Global feature flags exist (`features.ts`).                                                   | Per-region rollout.                                     | Layer a region dimension onto the existing flag resolution if/when needed.                                                             |

## Principle

Do not add international complexity speculatively. The core is ready; each market brings its
own concrete requirements (tax, language, tz) — implement those against the seams above when
the market is committed, not before.
