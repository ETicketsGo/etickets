# Known limitations

Everything known to be missing, unverified or blocked, as of 2026-10-24 (PRs 461, 476, 477 and
478 merged; Play Integrity and phone sign-in in PR 479).

## Blocked on an owner credential or decision

| Item                 | What exists                                                                               | What is needed                                                                                                                                                                                 |
| -------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Push notifications   | Registration, permission at the first booking, deregistration on sign-out (tested)        | Firebase project; `GOOGLE_SERVICES_JSON` to the build                                                                                                                                          |
| Crash reporting      | Sentry wired, PII-scrubbed                                                                | A Sentry project; `EXPO_PUBLIC_SENTRY_DSN` (+ `SENTRY_AUTH_TOKEN`)                                                                                                                             |
| Play upload          | EAS-managed upload keystore CREATED on Expo (2026-10-24)                                  | An EAS build: the Free plan is used up until 2026-11-01. Upgrade (owner, costs money) or wait.                                                                                                 |
| App Links            | Intent filter scoped; web route in PR 477                                                 | Signing fingerprint in `ANDROID_APP_LINKS` per environment                                                                                                                                     |
| Phone sign-in (OTP)  | Mobile tab + Play Integrity answer to the human check (PR 479, tested with a stub Google) | Cloud project linked in Play Console, Play Integrity API on, a service-account key on the API (PLAY-RELEASE.md section 7); an SMS provider (QA texts nobody); a Play-installed build to verify |
| Guest checkout       | Not offered                                                                               | A guest session token in the app; the human check is now answerable (PR 479)                                                                                                                   |
| Stripe (US) payments | Hosted page opens; the server's status decides                                            | Not exercised: no authorised Stripe test path on QA from this device                                                                                                                           |
| UPI                  | Razorpay shows it when the account has it                                                 | UPI is off on the QA Razorpay account                                                                                                                                                          |

## Built, not verified on a device

- Pinch-to-zoom on the seat map (adb cannot send two pointers; double-tap zoom is verified).
- QR read by a real gate scanner (the code is the server's own image).
- An ACCEPTED discount code (QA has no published offer on these events).
- A refund approved and paid out (requests are verified; approval is the organizer's).

## Deliberate decisions that look like gaps

- No certificate pinning: it breaks Railway certificate rotation and needs an app release to
  change.
- Saved tickets are not encrypted beyond the OS sandbox; the credential (`qrToken`) is never
  written to disk.
- The app is light only, like the website: dark is a "stage" band inside a page.
- The booking list itself is not stored offline; saved TICKETS are, and the Tickets tab shows
  them when the list cannot load.
