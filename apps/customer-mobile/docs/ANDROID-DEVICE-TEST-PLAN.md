# Android physical-device test plan

## The APK exists

|          |                                                                                |
| -------- | ------------------------------------------------------------------------------ |
| Build ID | `e739c419-0fdd-45c3-9197-b92803a51e26`                                         |
| Artifact | https://expo.dev/artifacts/eas/snwQQ1thxpB_G0rsGRoK_Fll7pKLiwISGUVbznXkgVo.apk |
| Project  | `@srinivasdeeptrics/eticketsgo-customer`                                       |
| Profile  | `qa` (internal distribution)                                                   |
| Size     | 111.1 MB                                                                       |
| Package  | `com.eticketsgo.customer.preview`                                              |
| ABIs     | arm64-v8a, armeabi-v7a, x86, x86_64                                            |

Verified by downloading and unpacking it, not by trusting the build status: valid ZIP,
`AndroidManifest.xml`, `classes.dex`, a 6.5 MB JS bundle, v1 signature, and the native
libraries that matter — `libreanimated.so`, `libworklets.so`, `libgesturehandler.so`,
`librnscreens.so`, `libhermesvm.so`.

`assets/app.config` confirms it is pointed at the right place:
`apiUrl: https://api-qa.eticketsgo.com/api`, `webHost: qa.eticketsgo.com`, and the EAS
project id. The manifest carries the `etickets` scheme and the `qa.eticketsgo.com`
app-link host.

Permissions in the shipped manifest: ACCESS_NETWORK_STATE, ACCESS_WIFI_STATE (NetInfo),
BIND_JOB_SERVICE, RECEIVE_BOOT_COMPLETED, WAKE_LOCK, READ_APP_BADGE (notifications),
USE_BIOMETRIC, USE_FINGERPRINT (SecureStore keychain), plus INTERNET,
POST_NOTIFICATIONS and VIBRATE. **No CAMERA, RECORD_AUDIO, WRITE_SETTINGS,
SYSTEM_ALERT_WINDOW or external storage** — the `blockedPermissions` held through to the
real binary.

**Status: STILL NOT EXECUTED ON HARDWARE.** An APK existing is not device validation.
There is no Android SDK, JDK, adb or emulator in the environment it was built from, so
nothing below has been run. Install it and work through the tiers.

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

| #   | Test                                                 | Watch for                                                                                                                                                 |
| --- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 8   | Cold launch from a killed state                      | Splash lifts; no blank screen (this exact failure was found and fixed on web)                                                                             |
| 9   | External payment browser handoff                     | Custom Tab opens with a real address bar                                                                                                                  |
| 10  | Return from the browser                              | Lands on the booking; status is **re-read from the server**, never assumed                                                                                |
| 11  | Kill the app mid-payment, relaunch                   | Booking shows its true server state, not a stale local guess                                                                                              |
| 12  | Deep link `etickets://tickets` from another app      | Opens the app on the Tickets tab                                                                                                                          |
| 13  | Deep link `etickets://booking/<id>` while signed out | Prompts sign-in, then **continues to the booking**                                                                                                        |
| 14  | `https://qa.eticketsgo.com/...` link                 | Will open the browser, not the app, until `assetlinks.json` is served — see DEEPLINKING.md                                                                |
| 15  | Android hardware back, every screen                  | Never traps; never exits from mid-stack                                                                                                                   |
| 16  | Back during checkout                                 | Does not lose an active hold silently                                                                                                                     |
| 17  | Offline ticket after airplane mode + force-stop      | Ticket renders from disk with a "Synced N ago" label                                                                                                      |
| 18  | Network loss mid-booking, then recovery              | Clear error, retry works, no duplicate booking (idempotency key is reused)                                                                                |
| 19  | Notification permission prompt                       | Appears after sign-in, not on first launch                                                                                                                |
| 20  | Device registers for push                            | The project id is in this build, so a token should be issued and `POST /users/me/devices` should return 201. Delivery still needs an APNs/FCM credential. |

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

## Getting another build

Login and project setup are done. A rebuild is one command:

```bash
cd apps/customer-mobile
npx eas-cli build --profile qa --platform android
```

Three attempts were needed for the first APK, and both failures were real bugs rather
than flakes — a rebuild today should go straight through:

1. `817c0def` — the shared workspace packages compile to gitignored `dist/`, and EAS runs
   `npm ci`, which does not build them. `tailwind.config.js` requires
   `@eticketsgo/design-tokens` and Metro died before bundling anything. Fixed with an
   `eas-build-post-install` hook that does what CI already did.
2. `46e56d74` — the Sentry Gradle plugin runs `sentry-cli` as a build task and fails the
   whole build when it cannot upload source maps. No auth token exists. Fixed with
   `SENTRY_DISABLE_AUTO_UPLOAD` on the credential-less profiles only; production still
   fails loudly, which is correct there.

Neither was reproducible locally: `dist/` always exists on a dev machine, and the Sentry
upload only runs during a release Gradle build.
