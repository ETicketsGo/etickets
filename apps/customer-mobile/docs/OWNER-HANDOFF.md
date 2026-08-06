# Owner handoff — first Android QA build

Everything below needs an account or a credential that does not exist in this repo. Each
command was checked against the actual repository state; none is a placeholder.

Run from `apps/customer-mobile`.

## Before you start

The QA build points at `https://api-qa.eticketsgo.com/api`, and **the API changes
in this branch are not deployed there yet**. Until PR #38 is merged and QA redeploys,
an installed APK will 404 on:

- `GET /public/movies/:slug/shows` (showtimes with pricing)
- `DELETE /users/me` (account deletion)
- `POST /users/me/devices` (push registration)

The rest of the app works against QA today. Merge first, confirm the redeploy, then
build — or build now and expect those three screens to fail.

Confirm the deploy landed:

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  https://api-qa.eticketsgo.com/api/public/movies/skyfront-protocol/shows
# 200 = deployed. 404 = not yet.
```

## 1. Log in to Expo

```bash
npx eas login
npx eas whoami
```

## 2. Create the EAS project

```bash
npx eas init
```

This writes `extra.eas.projectId` into the Expo config. **It is not there now**, which
is why `registerDevice()` currently returns null on a real device — `getExpoPushTokenAsync`
cannot issue a token without it. That is handled gracefully (push is skipped, nothing
breaks), but push will not work until this step is done.

`eas init` is the one command here that mutates account state, which is why it was not
run for you.

## 3. Secrets

None are required for a QA build. The only optional one:

```bash
npx eas secret:create --scope project --name SENTRY_AUTH_TOKEN --value <token>
```

Source maps upload without it failing the build; crashes are just harder to read.

**Do not** put any value in `eas.json` or `.env.example`. Both are committed.

## 4. Build the Android QA APK

```bash
npx eas build --profile qa --platform android
```

The `qa` profile is verified: internal distribution, APK, `com.eticketsgo.customer.preview`,
`EXPO_PUBLIC_ENV=staging`, the QA API URL, `qa.eticketsgo.com` as the deep-link host, and
no embedded secrets. `appVersionSource: remote` means EAS owns the build number.

First build takes ~15–25 minutes and generates a keystore. Let EAS manage it — that keeps
signing material off developer machines and out of git.

## 5. Install

EAS prints a QR code and a URL when the build finishes.

```bash
# Or, with a cable and platform-tools installed:
adb install <downloaded>.apk
```

## 6. Physical-device smoke test

Nothing below has ever been executed on hardware. Twenty checks, in order — the first
failure is the interesting one.

| #   | Check                          | Watch for                                                      |
| --- | ------------------------------ | -------------------------------------------------------------- |
| 1   | Cold launch                    | Splash lifts; no blank screen                                  |
| 2   | Home                           | Real events load from QA                                       |
| 3   | Search + category chips        | Debounce feels right, results change                           |
| 4   | Movie poster → detail          | Synopsis, cast, certificate                                    |
| 5   | Showtimes                      | Date chips, cinema grouping, prices                            |
| 6   | Tap a showtime                 | Reaches the seat map                                           |
| 7   | Seat map pinch/zoom/pan        | **Untested anywhere — gesture-handler needs a native runtime** |
| 8   | Select seats                   | Limit enforced, running total correct                          |
| 9   | Seat list view toggle          | Row-by-row alternative usable                                  |
| 10  | Continue → checkout            | Fees from the API, not computed locally                        |
| 11  | Sign in                        | Keychain-backed session survives a restart                     |
| 12  | Pay (QA mock)                  | Follows `clientActionUrl`; lands on the booking                |
| 13  | Return from browser            | Booking status re-read from the server                         |
| 14  | Tickets tab                    | Booking listed                                                 |
| 15  | QR renders                     | Screen brightens — **untested**                                |
| 16  | Airplane mode → reopen tickets | Cached ticket + "Synced N ago" label                           |
| 17  | Deep link `etickets://tickets` | Opens the app                                                  |
| 18  | Kill during payment, reopen    | Booking shows its real state                                   |
| 19  | Android back button            | Never traps or exits unexpectedly                              |
| 20  | Delete account                 | Signed out, tickets gone from device, cannot sign back in      |

Capture a screen recording of 6–10 and 20. Those are the two flows with no runtime
evidence at all.

## 7. iOS

Not possible from this environment and not attempted. Needs an Apple Developer account
and either macOS or an EAS iOS build:

```bash
npx eas build --profile qa --platform ios
```

## Still outstanding, owner-only

| Item                  | Action                                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| PR #38 merge          | Deploys the three new endpoint groups to QA                                                                              |
| 3 DNS CNAMEs          | `api-qa` → `ktndx6oh.up.railway.app`, `organizer-qa` → `31by3s2m.up.railway.app`, `admin-qa` → `s8wvm98p.up.railway.app` |
| APNs key / FCM config | Required before push delivers anything                                                                                   |
| Association files     | `assetlinks.json` and `apple-app-site-association` on the web host — see DEEPLINKING.md                                  |
| Legal pages           | `/legal/terms`, `/legal/privacy`, `/legal/refund-policy` must exist on the web host; the app links to them               |
