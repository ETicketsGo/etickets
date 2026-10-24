import AsyncStorage from '@react-native-async-storage/async-storage';
import { env } from './env';
import {
  deregisterDevice,
  getPermissionState,
  registerDevice,
  requestNotificationPermission,
} from './notifications';

/**
 * When this phone registers for push, and when it stops.
 *
 * OFF until the build carries a push credential (env.pushEnabled, set by app.config.ts when
 * GOOGLE_SERVICES_JSON is supplied to the build). Without one, Android cannot mint a token,
 * so asking for notification permission would be a promise the app cannot keep.
 *
 * With one:
 *  - signed in and permission already granted: register (no prompt);
 *  - the first confirmed booking: ask, once, because that is the moment a person sees why
 *    (a show can move or be cancelled), never a cold prompt at launch;
 *  - signing out: deregister, so a shared phone stops receiving the last person's updates.
 */
const DEVICE_KEY = 'etg.pushDeviceId';
const ASKED_KEY = 'etg.pushAsked';

async function remember(deviceId: string | null): Promise<void> {
  if (deviceId) await AsyncStorage.setItem(DEVICE_KEY, deviceId).catch(() => undefined);
}

/** After sign-in or launch with a session: register if the person already said yes. */
export async function syncPushRegistration(): Promise<void> {
  if (!env.pushEnabled) return;
  if ((await getPermissionState()) !== 'granted') return;
  const device = await registerDevice();
  await remember(device?.id ?? null);
}

/** After a confirmed booking: ask once, then register if allowed. */
export async function askForPushAfterBooking(): Promise<void> {
  if (!env.pushEnabled) return;
  const asked = await AsyncStorage.getItem(ASKED_KEY).catch(() => null);
  if (asked) return;
  await AsyncStorage.setItem(ASKED_KEY, '1').catch(() => undefined);
  if ((await requestNotificationPermission()) !== 'granted') return;
  const device = await registerDevice();
  await remember(device?.id ?? null);
}

/** On sign-out, while the session still exists. Best effort: never blocks signing out. */
export async function forgetPushDevice(): Promise<void> {
  const deviceId = await AsyncStorage.getItem(DEVICE_KEY).catch(() => null);
  if (!deviceId) return;
  await deregisterDevice(deviceId);
  await AsyncStorage.removeItem(DEVICE_KEY).catch(() => undefined);
}
