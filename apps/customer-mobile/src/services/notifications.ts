import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { z } from 'zod';
import { apiClient } from './api-client';
import { postParsed } from './http';
import { deviceLocale } from './locale';

/**
 * Push registration.
 *
 * ── WHAT IS WIRED, AND WHAT IS NOT ────────────────────────────────────────────────
 * The DEVICE side is complete: permission, token acquisition, registration with
 * POST /users/me/devices, permission-change reporting, deregistration on logout.
 *
 * DELIVERY is not, and cannot be from here. Sending needs an APNs key and an FCM
 * configuration, neither of which exists in this repo, plus an Expo project id, which
 * requires an Expo account. Nothing is faked to paper over that — docs/NOTIFICATIONS.md
 * lists the exact owner steps.
 *
 * This previously posted the token to /push/subscribe with `p256dh: 'expo'` and
 * `auth: 'expo'` as filler, because the only endpoint that existed was Web Push and a
 * native token has neither key. The real endpoint now exists and the placeholders are
 * gone.
 *
 * ── CONTENT RULE ──────────────────────────────────────────────────────────────────
 * A notification is readable on a lock screen by anyone holding the phone. No
 * credential, QR payload, payment detail or booking reference belongs in one. That is
 * enforced server-side when sending is built; it is stated here because this is the
 * file where it is easiest to forget.
 */
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    // SDK 56 split the foreground presentation flags: shouldShowAlert is deprecated in
    // favour of shouldShowBanner + shouldShowList (both required by NotificationBehavior).
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

/** Server response. The token comes back masked and is never echoed in full. */
const deviceSchema = z.object({
  id: z.string(),
  platform: z.string(),
  provider: z.string(),
  permissionStatus: z.string(),
  disabled: z.boolean(),
  tokenPreview: z.string(),
});

export type RegisteredDevice = z.infer<typeof deviceSchema>;

export type PermissionState = 'granted' | 'denied' | 'undetermined';

/**
 * Ask for notification permission.
 *
 * Deliberately separate from registration so the CALLER decides when to prompt. A cold
 * prompt on first launch, before the app has shown any reason to want one, is the
 * reliable way to be denied permanently — and on iOS there is no second chance.
 */
export async function requestNotificationPermission(): Promise<PermissionState> {
  try {
    const existing = await Notifications.getPermissionsAsync();
    if (existing.status === 'granted') return 'granted';
    // Never re-prompt once the user has said no: iOS silently no-ops and Android shows
    // nothing, so the app would appear broken. The caller sends them to Settings.
    if (!existing.canAskAgain) return 'denied';

    return toPermissionState((await Notifications.requestPermissionsAsync()).status);
  } catch {
    return 'undetermined';
  }
}

export async function getPermissionState(): Promise<PermissionState> {
  try {
    return toPermissionState((await Notifications.getPermissionsAsync()).status);
  } catch {
    return 'undetermined';
  }
}

/**
 * Register this device for push.
 *
 * Returns null rather than throwing on every failure path. Push is an enhancement: a
 * missing project id, a denied permission or an unreachable server must not stop anyone
 * using the app, and there is nothing a customer could do about any of them.
 *
 * ── NOT CURRENTLY REACHED ─────────────────────────────────────────────────────────
 * NOTHING IN THE APP CALLS THIS, and nothing calls `requestPermission()` either. Both
 * were verified unreferenced, and the consequence was measured on a device: after
 * registering an account, POST_NOTIFICATIONS was still `granted=false` and
 * `GET /users/me/devices` returned `[]`.
 *
 * It is deliberately still unwired rather than hooked up blind, because Android cannot
 * produce a token in this build regardless. The APK ships no `google-services.json`, so
 * logcat reports "Default FirebaseApp failed to initialize because no default options
 * were found" and `getExpoPushTokenAsync` has no FCM registration to ask. Calling this
 * after sign-in today would prompt for notification permission and then fail at the token
 * step — asking for a permission the build cannot honour is worse than not asking.
 *
 * Wiring it up is one call after authentication, and should land together with the FCM
 * credential (an owner step: create the Firebase project, upload the FCM key to EAS).
 * See docs/PUSH-NOTIFICATIONS.md.
 */
export async function registerDevice(): Promise<RegisteredDevice | null> {
  try {
    if (Platform.OS === 'web') return null;

    const permission = await getPermissionState();
    if (permission !== 'granted') return null;

    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('default', {
        name: 'Bookings and tickets',
        importance: Notifications.AndroidImportance.DEFAULT,
      });
    }

    /**
     * getExpoPushTokenAsync needs an EAS project id. One IS configured now (app.config.ts
     * carries extra.eas.projectId), so the earlier note here saying otherwise is no longer
     * true. On Android it still throws, for a different reason: the build has no FCM
     * registration. Caught and reported as "no token" rather than a server failure.
     */
    const projectId = (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)
      ?.eas?.projectId;
    const token = (await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined))
      .data;
    if (!token) return null;

    return await postParsed(
      '/users/me/devices',
      {
        token,
        provider: 'expo',
        platform: Platform.OS === 'ios' ? 'ios' : 'android',
        appVersion: Constants.expoConfig?.version ?? undefined,
        locale: deviceLocale.tag,
        timezone: deviceLocale.timeZone,
        permissionStatus: permission,
      },
      deviceSchema,
    );
  } catch {
    return null;
  }
}

/**
 * Tell the server the OS permission changed.
 *
 * Worth reporting: a backend that knows a device said no stops queueing sends it cannot
 * make and stops counting that person as reachable.
 */
export async function reportPermissionState(
  deviceId: string,
  permissionStatus: PermissionState,
): Promise<void> {
  await apiClient
    .patch(`/users/me/devices/${deviceId}`, { permissionStatus })
    .catch(() => undefined);
}

/**
 * Deregister on logout.
 *
 * Best-effort by necessity: the row may already be gone and the request may fail, and
 * neither must block signing out. The server also reassigns a token that later appears
 * under a different account, so a missed deregistration cannot strand notifications on
 * the wrong person.
 */
export async function deregisterDevice(deviceId: string): Promise<void> {
  await apiClient.delete(`/users/me/devices/${deviceId}`).catch(() => undefined);
}

function toPermissionState(status: string): PermissionState {
  if (status === 'granted') return 'granted';
  if (status === 'denied') return 'denied';
  return 'undetermined';
}
