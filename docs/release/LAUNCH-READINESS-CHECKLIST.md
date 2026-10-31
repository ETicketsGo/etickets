# Launch readiness checklist

> **Current as of 2026-10-30.** One checklist for the two launch cities and the mobile apps.
> Product state behind each line: [../PRODUCT-CURRENT-STATE.md](../PRODUCT-CURRENT-STATE.md).
> Older, platform-wide gates (rollback, incident, support) stay in
> [LAUNCH-CHECKLISTS.md](LAUNCH-CHECKLISTS.md).

Status values: **Done**, **Ready** (engineering done, waiting on the owner), **Open**, **Blocked**.
No item turns on billing, campaigns or payout transfers by itself; each needs the owner's explicit
approval.

## India: Hyderabad

| Area                  | Item                                               | Owner action                                                        | Engineering action                                                    | Dependency                        | Status  |
| --------------------- | -------------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------- | --------------------------------- | ------- |
| Organizer acquisition | First organizers and venues signed                 | Contact and sign organizers (CRM in the admin console)              | Support onboarding; fix defects found                                 | Organizer agreement text approved | Open    |
| Organizer acquisition | Organizer approval                                 | Approve each organizer (legal name, entity type, country)           | None                                                                  | Organizer submits details         | Ready   |
| Transactional SMS     | Login OTP via MSG91 (`ETKTGO`, 5 minutes)          | Keep MSG91 balance funded                                           | Monitor delivery receipts                                             | MSG91 account, DLT approvals      | Done    |
| Transactional SMS     | Booking confirmed / cancelled, password changed    | None                                                                | Monitor delivery receipts and cost                                    | DLT templates (approved)          | Done    |
| Transactional SMS     | Event reminder SMS                                 | Approve turning on the reminders job                                | Set `NOTIFICATION_REMINDERS_ENABLED` on the worker after approval     | Owner cost decision               | Ready   |
| Transactional SMS     | Password reset SMS, payment pending SMS, guest SMS | Decide whether these are needed for launch                          | Build the missing notification type / guest phone capture if approved | Owner decision                    | Open    |
| Razorpay readiness    | Live payments and webhook                          | Keep the live account in good standing                              | None                                                                  | Razorpay live account             | Done    |
| Razorpay readiness    | UPI and card methods on the live account           | Confirm methods in the Razorpay dashboard                           | Run one controlled purchase per method                                | Razorpay account settings         | Open    |
| Razorpay readiness    | Route payouts to organizers                        | Activate Route; approve the transfer gate                           | Prove post-transfer checks; keep transfers off until approved         | Razorpay Route activation         | Blocked |
| Razorpay readiness    | GST on the platform fee                            | Decide activation (it raises buyer totals)                          | Activate the shipped rules after the decision                         | Tax advice                        | Blocked |
| Event onboarding      | First real events published                        | Approve each event; approve public sales                            | Walk the buyer journey on PROD for each event                         | Signed organizers                 | Open    |
| Event onboarding      | Fee schedule for INR                               | Publish the INR fee schedule (draft, preview, publish with MFA)     | None                                                                  | Owner fee decisions               | Ready   |
| Marketing readiness   | Follows, audience, unsubscribe                     | None                                                                | None                                                                  | None                              | Done    |
| Marketing readiness   | Campaigns in PROD                                  | Provide the verified postal address; set up SES `updates@`; approve | Set `CAMPAIGNS_ENABLED` and marketing sender after approval           | Address, SES sender               | Blocked |
| Marketing readiness   | Local promotion and listings                       | Run local outreach and social                                       | Keep SEO pages indexable                                              | Real events to promote            | Open    |

## USA: Meridian, Idaho

| Area                   | Item                               | Owner action                                                     | Engineering action                                             | Dependency                          | Status  |
| ---------------------- | ---------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------- | ----------------------------------- | ------- |
| Organizer acquisition  | First organizers and venues signed | Contact and sign local organizers                                | Support onboarding                                             | Organizer agreement (DeepTrics LLC) | Open    |
| Stripe payments        | Live Stripe account                | Complete Stripe activation for DeepTrics LLC                     | Configure live keys and webhook; run one controlled purchase   | Stripe account review               | Blocked |
| Stripe payments        | USD routing to Stripe              | Approve the first live USD sale                                  | Confirm the Connect gate and route readiness                   | Live Stripe account                 | Ready   |
| Stripe Connect payouts | Organizer Connect onboarding       | Enable Connect on the platform account                           | Prove onboarding end to end; keep transfers off until approved | Stripe Connect approval             | Blocked |
| Platform fee config    | USD fee schedule                   | Decide USD fee bands; publish with MFA                           | None                                                           | Owner fee decisions                 | Open    |
| Platform fee config    | US sales tax on fees               | Get tax advice                                                   | Configure tax only after the decision                          | Tax advice                          | Blocked |
| SMS                    | Login OTP via Twilio               | Keep the Twilio account funded                                   | None                                                           | A2P registration                    | Done    |
| SMS                    | Transactional SMS for +1 numbers   | Decide whether to enable                                         | Add `US` to `SMS_TRANSACTIONAL_MARKETS` after approval         | Owner decision                      | Ready   |
| Marketing readiness    | Campaigns and marketing email      | Provide the verified LLC postal address; SES `updates@`; approve | Switch on after approval                                       | Address, SES sender                 | Blocked |
| Marketing readiness    | Local promotion                    | Run local outreach                                               | Keep SEO pages indexable                                       | Real events to promote              | Open    |

## Mobile

| Area    | Item                           | Owner action                                                                           | Engineering action                                               | Dependency                 | Status  |
| ------- | ------------------------------ | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | -------------------------- | ------- |
| Android | Organization developer account | Complete verification of the DeepTrics Software Solutions Private Limited Play account | None                                                             | Google verification        | Blocked |
| Android | Release candidate              | None                                                                                   | 1.0.0 (versionCode 4) signed AAB exists; rebuild if code changes | None                       | Done    |
| Android | Store listing                  | Approve listing text, privacy wording, screenshots from real events                    | Prepare listing assets; data-safety form                         | Real public events in PROD | Open    |
| Android | Play Integrity                 | Create the Google Cloud service account                                                | Set `PLAY_INTEGRITY_*` settings                                  | Play account               | Open    |
| Android | Production release             | Upload the AAB and roll out                                                            | Monitor crashes and sign-in                                      | All Android items above    | Open    |
| iOS     | Foundation and authentication  | Review PRs #458 and #459                                                               | Address review; merge when approved                              | Owner review               | Open    |
| iOS     | App Store readiness            | Apple developer account for the right entity; App Store listing                        | Payments, tickets and check-in screens; TestFlight build         | iOS PRs merged             | Open    |
