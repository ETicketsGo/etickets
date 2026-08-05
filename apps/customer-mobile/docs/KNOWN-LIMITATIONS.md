# Known limitations

Everything known to be missing, broken or unverified, in one place. Nothing here is
hidden elsewhere.

## Never executed on a device

The app has **not** run on an Android or iOS device or emulator. The environment it was
built in has no Android SDK, no `adb`, no Java, no emulator, and no macOS. What has run:

- 96 unit/contract tests (jest)
- a full Metro bundle (`expo export --platform web`)
- 18 runtime checks driving the real app in Chromium against the live QA API

That last one exercises the actual application code — router, providers, React Query, the
Zod parsers, the API client — but **react-native-web substitutes DOM elements for native
views**. It proves nothing about SecureStore, Brightness, Haptics, Notifications, gesture
handling, the native navigator, or how anything looks on a phone.

Consequently unverified: pinch/pan on the seat map, screen-reader behaviour, keychain
storage, the splash screen, deep links opening the app, the Android back button, push,
and every visual detail.

## API gaps that limit the app

Full detail in [API-INTEGRATION.md](API-INTEGRATION.md).

| Gap                                   | Effect                                                                                                                                            |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| No public movie → screenings route    | **Cinema booking is unreachable from discovery.** Seat selection is built and works; a film poster leads to a "not bookable in the app yet" card. |
| No per-show availability counts       | No "filling fast" or "N seats left" badge — it would be invented                                                                                  |
| No accessible/companion seat metadata | The app cannot identify wheelchair spaces and does not pretend to                                                                                 |
| No password reset endpoint            | No forgot-password flow                                                                                                                           |
| No account deletion endpoint          | **App-store blocker**                                                                                                                             |
| No guest-booking claim endpoint       | Guests cannot attach a booking to a new account                                                                                                   |
| No push device registration endpoint  | Push cannot be completed                                                                                                                          |

## Features not built

- Cinema showtimes UI (blocked above).
- Push notifications beyond permission and token acquisition — no credentials, no
  endpoint. No preference UI, because a toggle that changes nothing is a lie.
- Coupon entry at checkout. The API accepts `couponCode`; the field is not built.
- Add-ons and bundles. `/public/events/:id/addons` and `/bundles` exist and are unused.
- Reviews, recommendations, wallet passes, ticket transfer and sharing — all have API
  surface, none is built.
- Profile editing. `PATCH /users/me` exists; the screen is read-only.
- Legal links in Profile.
- Component-render tests and device E2E.

## Platform and infrastructure

- `api-qa.eticketsgo.com` is NXDOMAIN; the app points at the Railway hostname. That
  hostname is **not stable across service re-creation** — it has already changed once
  (`f23c` → `f580`). Override via `EXPO_PUBLIC_API_URL`; no code change needed.
- `preview` and `production` EAS profiles reference UAT and production API hosts that do
  not exist yet.
- Universal/app link association files are not served, so https links open the website.
- No EAS project id; `eas init` has not been run.
- App icons and splash are placeholder assets.

## Deliberate decisions that look like gaps

- **No certificate pinning.** It breaks Railway cert rotation and needs a native release
  to update. Revisit if card data ever transits the app.
- **Ticket cache is not encrypted beyond the OS sandbox.** SecureStore cannot hold a
  base64 QR image (Android warns past ~2KB). The credential (`qrToken`) is never written,
  so what a rooted device can read is a QR picture already displayed openly at a gate.
- **Web keeps tokens in memory only.** localStorage would expose a refresh token to any
  XSS. Web is a preview surface, not a shipping target.
- **No social login.** None exists server-side; a button that cannot work is worse than
  no button.
- **Session expiry does not clear cached tickets.** The usual cause is being offline —
  exactly when someone needs the ticket they already downloaded. Logout does clear them.
