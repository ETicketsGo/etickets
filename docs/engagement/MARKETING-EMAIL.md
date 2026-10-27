# Marketing email: sender, footer, unsubscribe and suppression

Owner decisions of 2026-10-27. Campaigns stay OFF (`CAMPAIGNS_ENABLED=false`) until the owner
switches them on; nothing here sends anything by itself.

## Sender

- `MARKETING_EMAIL_FROM` is `updates@eticketsgo.com` once SES has verified it (domain identity
  plus DKIM). Until then nothing may assume it. The From header reads
  `"<Organizer> via ETicketsGo" <updates@eticketsgo.com>`.
- `SES_MARKETING_CONFIGURATION_SET` keeps marketing bounces and complaints apart from ticket mail.
- STAGING and PRODUCTION refuse a campaign without both. LOCAL, DEV, QA and UAT fall back to
  `EMAIL_FROM` and `SES_CONFIGURATION_SET`, and the console says so.

## Footer postal address (per country)

The footer names the DeepTrics entity for the SENDING ORGANIZER's registered country and prints
that entity's verified business mailing address:

| Organizer country | Entity named                                 | Variable                      |
| ----------------- | -------------------------------------------- | ----------------------------- |
| India             | DeepTrics Software Solutions Private Limited | `MARKETING_POSTAL_ADDRESS_IN` |
| Anything else     | DeepTrics LLC (the platform operator, US)    | `MARKETING_POSTAL_ADDRESS_US` |

Fallback rules (`campaignFooterAddress`):

1. The variable for that entity's country.
2. Only if it is unset: the old single `MARKETING_POSTAL_ADDRESS`, when it exists.
3. Never the other country's address.
4. STAGING and PRODUCTION: neither set means the campaign is refused at review, at send and
   before each message (the worker pauses the campaign with `POSTAL_ADDRESS_MISSING`).
5. LOCAL, DEV, QA and UAT print the placeholder "Postal address pending verification (QA)".

No address is written in code or in this document. Only a verified address goes in the variable.

## Unsubscribe

- Every campaign carries two signed links in the footer: "Unsubscribe from <organizer>" (that
  organizer only) and "Unsubscribe from all marketing email" (every organizer and ETicketsGo
  marketing). Neither stops tickets, receipts, sign-in codes or refunds.
- The RFC 8058 one-click `List-Unsubscribe` header stays organizer-scoped.
- "All marketing" withdraws ETicketsGo marketing consent, withdraws every organizer consent the
  person has, and writes a MARKETING-scope suppression. An opt-in from the person's own account
  lifts that suppression and re-opens only what they grant again.
- `UNSUBSCRIBE_SIGNING_SECRET` signs the links. STAGING and PRODUCTION refuse to send a campaign
  (and refuse to sign a link) without it: there is no fallback to `JWT_ACCESS_SECRET` there.
  Elsewhere the key may be derived from `JWT_ACCESS_SECRET`. Rotating the secret breaks every
  link already sent, so set it once per environment and keep it.

## Complaints and bounces

`SuppressedDestination.scope`:

| Event                                  | Scope       | Stops                                        |
| -------------------------------------- | ----------- | -------------------------------------------- |
| Hard bounce, invalid, provider block   | `ALL`       | every email, tickets included (address dead) |
| SMS STOP                               | `ALL`       | that channel                                 |
| Spam complaint                         | `MARKETING` | every campaign and ETicketsGo marketing      |
| "Unsubscribe from all marketing email" | `MARKETING` | the same                                     |

Essential transactional messages (tickets, booking confirmations, receipts, OTP and sign-in
codes, password resets, refunds) read only `ALL` rows. Rows are never deleted; a lift records who
and when. Complaints recorded before this change were moved to `MARKETING` by the migration,
keeping their reason, provider and dates.
