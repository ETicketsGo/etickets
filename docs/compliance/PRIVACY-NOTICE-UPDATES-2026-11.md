# Privacy notice updates: India and USA (draft, not published)

**Status:** DRAFT for owner and counsel review. Nothing here is live.

- **What it changes:** `apps/customer-web/app/[locale]/privacy/page.tsx` (sections 3, 4, 8 and 11) and the India supplement in `packages/shared-types/src/legal.ts`.
- **Placeholders:** every `«…»` is a fact only the owner can supply. **None may be invented.**
- **Policy version:** publishing means a new PRIVACY version in the registry. Consent rows record the version, so the bump matters.

## Why

The 2026-11-12 audit found that the notice:

- names Razorpay and Stripe, but no other sub-processor;
- does not say data is hosted in the United States;
- gives no privacy email and no grievance officer.

**India today:** the SPDI Rules 2011, rule 4 (privacy policy) and rule 5(9) (grievance officer) apply. From 13 May 2027 DPDP Rules 3, 9 and 14 add:

- an itemised notice;
- a contact for questions;
- grievance redressal within 90 days.

**US:** under FTC Act s.5, the notice must match practice.

## Section 3: Sharing (replace the sub-processor sentence)

> **Service providers.** We use these companies to run ETicketsGo, under contracts that limit them to providing their service to us:
>
> | Provider             | What for                                     | Where          |
> | -------------------- | -------------------------------------------- | -------------- |
> | Railway              | Hosting our servers, database and backups    | United States  |
> | Amazon Web Services  | Sending email                                | India (Mumbai) |
> | Razorpay             | Payments in India                            | India          |
> | Stripe               | Payments in the United States                | United States  |
> | MSG91                | Text messages to Indian numbers              | India          |
> | Twilio               | Text messages to US and Canadian numbers     | United States  |
> | Expo                 | App notifications                            | United States  |
> | «Sentry, if enabled» | Error reports, with personal details removed | «region»       |
>
> Payment providers receive your card or UPI details directly; we never see or store them.

Each "Where" entry is to be confirmed against each provider's DPA. Only Railway us-west2 and AWS ap-south-1 were verified, in the audit.

## Section 4: Retention (add after the first paragraph)

> Sign-in codes and password-reset links are deleted 30 days after they expire. Payment notifications from our payment providers are kept without your contact or card details. Records of purchases, refunds and payouts are kept for as long as tax and accounting law requires, with your name and contact details removed if you delete your account.

Publish only once #649 and #652 are deployed **and** the purge is enabled (`RETENTION_PURGE_ENABLED=true`). Until then, the sentence is not yet true.

## Section 8: Your country (add)

> **Where your data is stored.** ETicketsGo stores data in the United States, on servers run by Railway, whichever country you live in. Some services run elsewhere; see the list of service providers above. We protect data the same way wherever it is processed.

## Section 11: Changes & contact (replace the contact sentence)

> Questions about this policy or your data: «privacy email». You can also use the [contact page](/contact).

## India supplement (`TERMS/PRIVACY IN` registry entry): add

> **Grievance Officer.** «Name», «designation», DeepTrics Software Solutions Pvt Ltd, «registered address», «email». We acknowledge a grievance within «48 hours» and resolve it within «30 days». The law allows up to 90 days; counsel to confirm the figure we commit to.
>
> **Your rights.** You can ask us for a summary of the personal data we hold about you and who we shared it with, ask us to correct or erase it, and nominate someone to exercise these rights for you. Write to the Grievance Officer.

The legal entity named as data fiduciary is open. It depends on `docs/compliance/LEGAL-REVIEW-QUESTIONS.md`, which asks which entity contracts with an Indian buyer.

## US supplement: add

> **Your choices.** You can delete your account at any time (see Retention). We do not sell personal information and do not share it for cross-context behavioural advertising. We do not use tracking cookies or advertising pixels.
>
> **Text messages.** Message frequency varies. Reply STOP to opt out and HELP for help. Message and data rates may apply. Consent is not a condition of purchase.

The text-message wording must match the A2P 10DLC campaign registration (`docs/compliance/A2P_10DLC_READINESS.md`).

## Publishing steps (after approval)

1. The owner supplies every `«…»`, and counsel approves the text.
2. Add a new PRIVACY version in `legal.ts` (GLOBAL, IN and US rows; the old rows stay).
3. Update the page and its tests. The test **"removing the selector did not collapse every market onto one policy"** must still pass.
4. Deploy customer-web through the normal release (owner approval for PROD).
