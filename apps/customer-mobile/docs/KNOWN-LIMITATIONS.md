# Known limitations

Everything known to be missing, unverified or blocked, as of 2026-10-24 (branch
`feat/android-v1`, PR 476). Rewritten: the previous version predated movies, account
deletion, the redesign and device testing.

## Blocked on an owner credential or decision

| Item                 | What exists                                                                        | What is needed                                                                                                                                                                      |
| -------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Push notifications   | Registration, permission at the first booking, deregistration on sign-out (tested) | Firebase project; `GOOGLE_SERVICES_JSON` to the build                                                                                                                               |
| Crash reporting      | Sentry wired, PII-scrubbed                                                         | A Sentry project; `EXPO_PUBLIC_SENTRY_DSN` (+ `SENTRY_AUTH_TOKEN`)                                                                                                                  |
| Play upload          | Production AAB builds (debug-signed locally)                                       | Upload key: EAS-managed or self-held (PLAY-RELEASE.md section 2)                                                                                                                    |
| App Links            | Intent filter scoped; web route in PR 477                                          | Signing fingerprint in `ANDROID_APP_LINKS` per environment                                                                                                                          |
| Phone sign-in (OTP)  | API route exists                                                                   | It requires a browser human check (Turnstile) a native app cannot run. Needs a mobile-safe bot check (Play Integrity, or an attested exemption) decided by the owner. Not bypassed. |
| Guest checkout       | Not offered                                                                        | Same human check as above, plus the guest session token                                                                                                                             |
| Stripe (US) payments | Hosted page opens; the server's status decides                                     | Not exercised: no authorised Stripe test path on QA from this device                                                                                                                |
| UPI                  | Razorpay shows it when the account has it                                          | UPI is off on the QA Razorpay account                                                                                                                                               |

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
