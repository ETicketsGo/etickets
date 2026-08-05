# Android physical-device test plan

**Status: NOT EXECUTED.** No Android SDK, JDK, adb or emulator exists in the environment
this was built in, and EAS reports "Not logged in" with no `EXPO_TOKEN`. No APK has been
produced, so there is no build URL or build ID to quote. Nothing in this app has run on
Android hardware.

This plan exists so the first person with a device does not have to invent one, and it is
ordered by **native risk** — the things that cannot be caught by tests, a web bundle, or
a browser, and are therefore genuinely unknown.

## What has been validated, and by what

| Layer                 | How                                     | Result       |
| --------------------- | --------------------------------------- | ------------ |
| Business logic        | 133 mobile + 1290 API tests             | green        |
| API contracts         | live QA probes with disposable accounts | green        |
| Whole app bundling    | `expo export` through Metro             | green        |
| App behaviour         | real Chromium, phone viewport, live API | 24/24        |
| Native config         | `expo prebuild` + manifest inspection   | green        |
| Native module linking | autolinker resolution, both platforms   | 0 duplicates |
| **Native runtime**    | —                                       | **nothing**  |

react-native-web substitutes DOM elements for native views, so every row above the last
one tells you nothing about SecureStore, Brightness, Haptics, Notifications, gesture
handling, or the platform navigator.

## Tier 1 — no evidence of any kind exists

Run these first. A failure here is most likely and most expensive.

| #   | Test                                     | Why it is unknown                                                                           | Expected                                                                 |
| --- | ---------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 1   | Seat map pinch-zoom and two-finger pan   | `react-native-gesture-handler` + Reanimated worklets need a native runtime. Never executed. | Smooth zoom 1×–3×, snap back at 1×, no jank on 80 seats                  |
| 2   | Seat tap accuracy while zoomed           | Seats are ~18–30px; hit targets and the gesture layer interact                              | The tapped seat selects — not its neighbour                              |
| 3   | Double-tap to zoom                       | Competing tap/pinch recognisers                                                             | Toggles 1× ↔ 2×, does not also select a seat                             |
| 4   | QR brightness raise **and restore**      | `expo-brightness` is native-only. The restore path runs in an effect cleanup.               | Screen brightens on the ticket; returns to the previous level on leaving |
| 5   | QR scannability                          | A real scanner against a real panel                                                         | Scans first time at arm's length                                         |
| 6   | Keychain persistence across cold restart | `expo-secure-store` is a native module; the web build uses an in-memory stub                | Still signed in after force-stop and relaunch                            |
| 7   | Haptics                                  | `expo-haptics` is a no-op off-device                                                        | Light tap on buttons, warning on a blocked seat                          |

## Tier 2 — native integration points

| #   | Test                                                 | Watch for                                                                                  |
| --- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 8   | Cold launch from a killed state                      | Splash lifts; no blank screen (this exact failure was found and fixed on web)              |
| 9   | External payment browser handoff                     | Custom Tab opens with a real address bar                                                   |
| 10  | Return from the browser                              | Lands on the booking; status is **re-read from the server**, never assumed                 |
| 11  | Kill the app mid-payment, relaunch                   | Booking shows its true server state, not a stale local guess                               |
| 12  | Deep link `etickets://tickets` from another app      | Opens the app on the Tickets tab                                                           |
| 13  | Deep link `etickets://booking/<id>` while signed out | Prompts sign-in, then **continues to the booking**                                         |
| 14  | `https://qa.eticketsgo.com/...` link                 | Will open the browser, not the app, until `assetlinks.json` is served — see DEEPLINKING.md |
| 15  | Android hardware back, every screen                  | Never traps; never exits from mid-stack                                                    |
| 16  | Back during checkout                                 | Does not lose an active hold silently                                                      |
| 17  | Offline ticket after airplane mode + force-stop      | Ticket renders from disk with a "Synced N ago" label                                       |
| 18  | Network loss mid-booking, then recovery              | Clear error, retry works, no duplicate booking (idempotency key is reused)                 |
| 19  | Notification permission prompt                       | Appears after sign-in, not on first launch                                                 |
| 20  | Device registers for push                            | **Will return null until `eas init` is run** — there is no project id yet                  |

## Tier 3 — account and cleanup

| #   | Test                                 | Expected                                                            |
| --- | ------------------------------------ | ------------------------------------------------------------------- |
| 21  | Sign in, then account deletion       | Typed `DELETE` confirmation required                                |
| 22  | Immediately after deletion           | Signed out; cached tickets gone from the device                     |
| 23  | Same session token after deletion    | Rejected at once — verified server-side on QA, unverified on device |
| 24  | Sign in again with the deleted email | Refused                                                             |
| 25  | Logout                               | Device deregistered; every account's cached tickets cleared         |

## Permissions to eyeball at install

The manifest should request **exactly three**: `INTERNET`, `POST_NOTIFICATIONS`,
`VIBRATE`. It previously asked for nine — camera, microphone, draw-over-other-apps,
modify-system-settings and external storage were all removed once `expo prebuild`
exposed them. If any of those reappears on the install prompt, a transitive plugin has
added it back and `src/services/__tests__/app-permissions.test.ts` should have caught it.

## Recording a failure

For each: exact steps, device model, Android version, and `adb logcat` output with
tokens and QR payloads stripped. Then classify — mobile, API, configuration, or
environment — because the fix differs and the wrong classification wastes the next
person's time.

## Getting a build

See [OWNER-HANDOFF.md](OWNER-HANDOFF.md). Short version:

```bash
cd apps/customer-mobile
npx eas login
npx eas init                                    # creates the project id; push needs it
npx eas build --profile qa --platform android   # internal-distribution APK
```
