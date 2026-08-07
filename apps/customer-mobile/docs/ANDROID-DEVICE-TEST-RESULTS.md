# Android device test results

The app has now actually run on Android. Everything below was observed on a booted
Android 14 runtime with the genuine EAS APK installed — nothing here is inferred from
reading code, and where something could not be observed it says so instead of passing.

| | |
| --- | --- |
| Device | Android emulator, `sdk_gphone64_x86_64`, AVD `etg-qa` |
| Android | 14 (API 34), 1080×2400 |
| APK under test | build `e739c419-0fdd-45c3-9197-b92803a51e26`, from commit `4b75c2a` |
| Package | `com.eticketsgo.customer.preview` 0.1.0+1 |
| API | `https://api-qa.eticketsgo.com/api` (live QA) |
| Follow-up build | `b2763a6c-da06-4c76-ba08-3468e302f61e`, carrying the five fixes below |

x86_64 emulator rather than an arm phone. That covers the JS, the layout, the navigator,
gesture recognisers, SecureStore, AsyncStorage, Brightness and the whole networking path.
It does not cover arm-specific native code paths, real GPU timing, or a physical scanner
reading the QR off a real panel — those still need a handset, and QR scannability in
particular remains unverified by anything.

## Defects found, and what happened to them

Five were repository-controlled and are fixed with regression tests. Two are not mine to
fix and are described precisely instead.

### P0 — the booking flow could not complete. FIXED

Tapping "Continue to payment" produced **"Something went wrong / The request failed
validation."** with the seats already held. Reproduced with a fresh selection, so it was
not staleness.

The booking and the payment intent were both fine — a live QA account showed the bookings
really had been created (`PENDING_PAYMENT`), and `POST /bookings/:id/pay` returned a
proper `clientActionUrl`. The failure was the third step. `followPaymentAction` posted the
returned action URL with **no request body at all**:

```js
await apiClient.post(path); // axios sends no body
```

Nest hands `@Body()` `undefined`, and a Zod object schema rejects `undefined` even when
every field inside it has a default — so the gateway's
`{ outcome: enum.default('succeeded') }` 400s before any payment logic runs. Confirmed by
replaying it against QA: no body → `VALIDATION_FAILED` with `fields: { _: ["Required"] }`,
`{}` → passes validation.

Fixed by sending `{}`. The existing test asserted `toHaveBeenCalledWith(path)` with no
body, so it had **pinned the broken shape**; it now asserts the body, plus a dedicated
test for it.

### P1 — launching offline destroyed the session. FIXED

In aeroplane mode after a force-stop, the Tickets tab showed "Sign in to see your
bookings" — and signing in needs the network, so tickets cached on the device for exactly
this situation were unreachable. This is the venue-with-no-signal case the offline cache
exists for.

Worse than a bad screen: the session was **deleted**, not just hidden. `hydrate()` called
`GET /auth/me` and treated any failure as "not signed in":

```js
catch { await tokenStore.clear(); set({ status: 'unauthenticated', user: null }); }
```

`me()` is a network call, so no signal meant a valid refresh token was wiped from the
keychain and did not come back when signal did. Confirmed on the device: after the offline
launch the Profile tab read "You're browsing as a guest".

Fixed by separating "the server rejected us" from "we could not reach the server". A 401
still clears everything immediately; an unreachable server keeps the session and restores
a last-known-user snapshot, which the ticket cache needs anyway since it is namespaced by
user id. The same one-line flaw existed in the api-client's refresh path, where a
connection dropping between the 401 and the refresh signed the user out permanently — also
fixed.

### P0 — the app crashed on creating an account. FIXED

Submitting the Create-account form killed the process. No error screen, no report: the
launcher reappeared and the user would reasonably assume it had failed. **The account was
created server-side** (login returned 201 afterwards), so they would then be unable to
register again with that address. Reproduced 2/2.

```
FATAL EXCEPTION: main
java.lang.IllegalStateException: addViewAt: failed to insert view [812] into parent [858] at index 4
Caused by: The specified child already has a parent. You must call removeView() first.
  at com.facebook.react.views.view.ReactClippingViewManager.addView
… addViewAt: cannot insert view [812] into parent [858]: View already has a parent: [814]
  Parent: ReactViewGroup View: ReactEditText
```

A Fabric **view-flattening** crash. Fabric removes Views that need no native view of their
own; the shared `Field` applies `opacity-50` only while `editable` is false, so
`editable={!submitting}` on the register form changed whether that wrapper existed
natively at submit time. Android then had to move the `TextInput` between parents, and a
`ReactEditText` is never flattened — it already has a real parent, so the move throws.

The login screen escaped only because it happens to define its own local field component
and never toggles `editable`.

Fixed with `collapsable={false}` on the wrapper, so it stays native in both states and the
input never changes parent. A unit test cannot reproduce a native mounting crash, so the
test added instead fails if the opt-out is ever removed.

### P2 — "Upcoming (5)" against one real ticket. FIXED

The Tickets tab counted lapsed holds as upcoming. On a live QA account it read
**"Upcoming (5)"** with four `EXPIRED` bookings and one `CONFIRMED` — one real ticket, a
badge claiming five, and dead entries filling the surface people open to check they have a
ticket.

The split is by session time, which is right for live bookings, but a lapsed hold for a
future date is not "upcoming" in any sense a person means it. Now excluded by status, with
Past taking the exact complement so nothing falls out of both tabs. Matched by exclusion,
so an unrecognised status from a newer API stays visible rather than vanishing.

### P2 — an unpaid booking rendered as an unknown status. FIXED

`bookingTone` mapped `PENDING`, `HELD` and `AWAITING_PAYMENT`, but the status the deployed
API actually emits is **`PENDING_PAYMENT`** — so the one state that needs the customer to
act fell through to the grey reserved for statuses the app has never heard of.

An existing test asserted `bookingTone('PENDING_PAYMENT') === 'neutral'`, describing the
code rather than the intent. That assertion was corrected, with the neutral fallback still
covered by an explicitly unknown status.

### Payment cannot be completed on QA at all — NOT a mobile defect, owner action

Independent of the P0 above, and the reason full payment remains unverified on device.

`MockPaymentProvider.createPayment` returns `/api/payments/:id/mock-pay` unconditionally,
while `PaymentsService.mockPay` refuses when `NODE_ENV === 'production'`:

```js
private readonly mockEnabled =
  process.env.PAYMENTS_MOCK_ENABLED !== 'false' && process.env.NODE_ENV !== 'production';
```

QA is a deployed service, so `NODE_ENV=production` and the API **advertises an action it
will always refuse**. Verified against QA: with a valid body the call returns
`FORBIDDEN — "Mock payments are disabled in this environment."` So no client, mobile or
web, can finish a payment on QA — there is no mock and no real sandbox provider wired.

Deliberately not "fixed" here. That guard is doing its job and weakening it to make a test
pass would put a fake payment path in a production-mode runtime. The resolutions are the
owner's: wire real sandbox credentials on QA (the already-known gate), or introduce a
proper environment-name concept so a deployed non-production environment can enable the
mock without relaxing the production check. `NODE_ENV` cannot carry that distinction.

### Push notifications cannot work in this build — two blockers, one is owner action

Verified, not assumed: after registering an account, `POST_NOTIFICATIONS` was still
`granted=false` and `GET /users/me/devices` returned `[]`.

1. **Nothing calls it.** `registerDevice()` and `requestPermission()` are fully
   implemented and unit-tested in `services/notifications.ts`, and no code anywhere in the
   app invokes either. The permission is never requested and no device is ever registered.
2. **Android cannot mint a token regardless.** The APK ships no `google-services.json`, so
   logcat reports `Default FirebaseApp failed to initialize because no default options
   were found` and `getExpoPushTokenAsync` has no FCM registration to ask.

Left unwired on purpose. Hooking (1) up today would prompt for notification permission and
then fail at the token step — asking for a permission the build cannot honour is worse
than not asking. Both should land together once the FCM credential exists, which needs a
Firebase project and an upload to EAS. A stale comment claiming the EAS project id was
missing has been corrected; the project id is configured, FCM is what is absent.

## Test results

30 Tier-1 checks. **19 passed, 6 blocked, 5 not deliverable by this harness.** No test is
marked passed from reading code.

### Passed on the device

| # | Test | Evidence |
| --- | --- | --- |
| 1 | Cold launch from killed state | Splash lifts, no blank screen |
| 2 | Session restored across a process kill | pid 4666 → dead → 8590, returned as "Hi, Riya" |
| 3 | Public discovery loads | Movies and events from live QA |
| 4 | Movie → showtime | Skyfront Protocol → 2:42 PM IMAX Screen 1 |
| 5 | Reserved seat map renders | 80 seats, 3 categories, screen marker |
| 6 | Double-tap zoom + restore | Selected seat measured **62px → 126px = 2.03×** in the framebuffer |
| 8 | Seat tap accuracy | A1/A2 exact, ₹400 |
| 9 | Max-seat enforcement | 10 seats ₹2,000; 11th refused |
| — | Tap accuracy **while zoomed 2×** | Tap 6px inside a seat's left edge selected that seat; 4px inside its neighbour's right edge toggled the neighbour. Never off-by-one |
| 10 | Hold countdown | "Tickets held for 4:56" ticking down to 3:00; fees ₹400 + ₹18 = ₹418 from the server, CTA became "Pay ₹418" |
| 11 | Hold expiry | At zero: "Your hold expired — those tickets have been released", and it navigated back to the seat map rather than stranding the user. Server released all 80 seats and marked the bookings EXPIRED |
| — | Retry reuses the hold | A second attempt reused the existing booking instead of holding a second set of seats |
| 12 | QR renders | `TKT-05320161CB2E`, ACTIVE |
| 13 | Brightness raised on the ticket | logcat `Brightness [1.0] reason=override` |
| 18 | Logout scrubs the ticket cache | **Zero `etg.*` keys left in AsyncStorage on disk** — checked in the sqlite file, not the UI |
| 27 | Android hardware back | Never trapped, never exited mid-stack |
| 28 | Deep links | `etickets://tickets` and auth-aware continuation |
| — | Cold launch fully offline | No blank screen, banner "You're offline — showing saved data", session restored with no network |
| — | Seat map reflects others' holds | Seats held by another account showed "on hold by another customer" |

### Failed, then fixed — awaiting re-verification on build `b2763a6c`

| # | Test | Status |
| --- | --- | --- |
| 14 | Brightness **restored** on leaving the ticket | Was P1: `dumpsys display` still showed `mBrightnessReason=override` after BACK; the override only released when Android reclaimed the window on HOME. Stale-closure fix + 7 tests |
| 17 | Offline cached ticket | Was P1: the offline launch showed the signed-out state and destroyed the session |
| 19 | Payment handoff | Was P0: bodyless POST. Fix clears validation; full completion still blocked by the QA config gap above |
| 23 | Account creation | Was P0: native crash |

### Blocked, and honestly so

| # | Test | Why |
| --- | --- | --- |
| 20–22 | Payment return / kill mid-payment / recovery | Cannot start a payment on QA at all — see the config gap. Not a mobile defect and not something a mobile fix can unblock |
| 25 | Device registers for push | No FCM in the build; nothing is called either |
| 26 | Logout deregisters the device | Nothing to deregister, since 25 never registers one |

### Not deliverable by this harness

Reported as untested rather than passed or failed. These are harness limits, **not**
product findings, and no defect is filed for them.

| # | Test | Why |
| --- | --- | --- |
| 7 | Pinch-to-zoom and two-finger pan | See below |
| — | QR read by a real scanner | Needs a physical scanner and a real panel |
| 15/16 | Haptics; brightness after task termination | Not observable through adb |
| 24 | Sign-in refused after account deletion | Deletion needs a disposable account and a payment-complete state that QA cannot reach |

**On pinch:** genuine two-pointer input could not be delivered. `adb shell input swipe` is
single-pointer. Writing MT events to `/dev/input` needed root, then `ABS_MT_SLOT` before
the tracking id, then the single-touch `ABS_X`/`ABS_Y` axes alongside the MT axes — at
which point a synthetic single-finger tap did select a seat, so the path worked. But the
pointer-location overlay reported **`P: 1 / 1`** for every two-finger attempt, whether the
fingers were written to two device nodes or to two slots on one node: the kernel accepted
slot 1 and gave it a tracking id, and Android's InputReader never promoted it to a second
pointer. Without two pointers reaching the app, "pinch does nothing" would have been a
statement about the harness, so it is not reported as a defect.

Partial coverage does exist: double-tap zoom works and was **measured** at 2.03×, which
means `react-native-gesture-handler`'s recognisers and Reanimated's worklet-driven
transform both run correctly on the native runtime. That was the largest unknown. Pinch
and two-finger pan share that stack, so the residual risk is a recogniser configuration
question, not "do worklets work on device".

## Smaller findings, not fixed

Real, observed, and deliberately left alone — each is a judgement call rather than a
defect, and bundling them into a native-QA change would widen its scope.

- **The sign-in screen has no route to registration.** Registration links to sign-in, but
  not the reverse. Someone arriving from Profile without an account has to go back and find
  the Tickets tab.
- **The sign-in screen's content is vertically centred**, so the keyboard covers the submit
  button and it must be dismissed to sign in. The register screen is top-aligned and does
  not have this problem.
- **A CONFIRMED booking showed "Reference: Issued on confirmation"** — a placeholder for a
  reference that will now never be issued, on a booking that is already confirmed.
- **Validation errors drop their field detail.** The API returns
  `details.fields: { fullName: ["Required"] }` and the app surfaces only "The request
  failed validation", which tells the user nothing to act on.
- **"See all" on the movies rail opens the events search**, listing events rather than
  movies.
- **Accessibility bounds do not follow the zoom.** `uiautomator` reports a 62px seat at
  both 1× and 2×, because the transform is applied on the UI thread. A screen-reader user
  who zooms gets stale coordinates. Likely a Reanimated platform behaviour rather than
  something this app controls, but worth knowing.

## One unexplained observation

The app was signed out at a point where I had also logged into the same seed account over
curl. Refresh tokens rotate with family-burn reuse detection, so a token presented twice
signs the user out everywhere — and force-stopping the app between the server rotating a
token and SecureStore persisting it would leave the device holding a revoked one.

That is a plausible mechanism and a real hazard worth watching, but I interfered with the
account externally and cannot attribute the sign-out confidently, so it is recorded as an
observation rather than a defect. The api-client's single-flight dedupe was reviewed and is
correct: the `??` assignment is synchronous, so concurrent 401s share one refresh.

## Notes for whoever runs this next

- `uiautomator dump` fails with "could not get idle state" whenever the screen animates
  continuously — the hold countdown ticks every second. It leaves the **previous** dump on
  the device, so a naive helper reads stale UI and reports a dialog as still open long
  after it closed. Delete the file first and treat a missing file as the error it is. This
  cost real time and nearly produced a fabricated defect.
- Accessibility bounds cannot measure zoom. Read the framebuffer instead:
  `adb exec-out screencap` without `-p` gives a raw header plus RGBA rows and skips PNG
  decoding entirely. The selected seat is the only reliably-coloured object on the map and
  makes a good zoom marker.
- Don't reuse a seed account over curl while testing the session on the device. Token
  rotation makes the two interfere, which is how the unexplained sign-out above happened.
- Holds expire on their own, so QA seat inventory self-heals; all 80 seats were confirmed
  released afterwards. Use disposable `qa-dev-*@eticketsgo.test` identities for anything
  account-shaped.

## Test count

161 mobile tests across 15 suites, up from 133. The 28 added all came from something
observed on the device, and each was checked to fail against the original code — the
brightness and offline-session tests were run against the pre-fix implementations to
confirm they catch the real defect rather than merely describing the new one.
