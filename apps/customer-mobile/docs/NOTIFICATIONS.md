# Push notifications

## Status: architecture only — NOT WIRED

No Expo account, APNs key, FCM configuration or backend registration endpoint was
available. The client architecture exists; nothing has been sent or received, and no
credentials were invented.

## What exists

`src/services/notifications.ts`, called from the authenticated area on sign-in.

- Permission request, contextually — after sign-in, not on first launch. A cold
  permission prompt before any value is shown is the reliable way to get denied
  permanently.
- Expo push token acquisition.
- Android notification channel setup.
- Logout is expected to clear the token (see gap below).

## What is missing, and why

| Missing                               | Blocker                                                                                           |
| ------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Backend device registration           | **No endpoint exists.** `PushRegistration` is defined in `shared-types` but no route consumes it. |
| APNs key / FCM `google-services.json` | Owner credentials                                                                                 |
| Expo project id                       | Requires an Expo account (`eas init`)                                                             |
| Token refresh handling                | Depends on a registration endpoint                                                                |
| Preference UI                         | Deliberately not built — a toggle that changes nothing is a lie                                   |
| Delivery testing                      | Requires all of the above plus a device                                                           |

### Smallest additive contract needed

```
POST /users/me/devices
  { endpoint: string, keys?: { p256dh, auth }, userAgent?: string, platform: 'ios'|'android' }
  → 201 { id }

DELETE /users/me/devices/:id     # called on logout
```

`PushRegistration` in `@eticketsgo/shared-types` already matches this shape.

## Content rules (enforced when this is wired)

Never in a notification body, and never logged:

- passwords or tokens of any kind
- `qrToken` or any part of a QR payload
- full payment data
- sensitive personal fields

A notification is readable on a lock screen by anyone holding the phone. "Your tickets
for Sunburn Arena are ready" is appropriate; a booking reference or seat number is not.

## Owner steps to enable

1. `npx eas init` in `apps/customer-mobile` (creates the Expo project id).
2. Upload an APNs key and an FCM server key via `eas credentials`.
3. Implement the two endpoints above.
4. Set `extra.eas.projectId` in `app.config.ts`.
5. Build a dev client — push does not work in Expo Go on Android for SDK 53+.
6. Test delivery foreground, background and killed, on a physical device.
