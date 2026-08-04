import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import type { PushRegistration } from '@eticketsgo/shared-types';
import { apiClient } from './api-client';

/**
 * Push registration wrapper. Requests permission, gets the Expo push token, and
 * registers it with the existing notifications API (the same channel the web app's
 * Web Push uses — no new backend). Best-effort; failures never block the app.
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

export async function registerForPush(): Promise<string | null> {
  try {
    const settings = await Notifications.getPermissionsAsync();
    let status = settings.status;
    if (status !== 'granted') {
      status = (await Notifications.requestPermissionsAsync()).status;
    }
    if (status !== 'granted') return null;

    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('default', {
        name: 'Default',
        importance: Notifications.AndroidImportance.DEFAULT,
      });
    }

    const token = (await Notifications.getExpoPushTokenAsync()).data;
    // Reuse the existing push subscription endpoint (device-token variant); body typed
    // with the shared PushRegistration contract — no duplicated DTO.
    const body: PushRegistration = {
      endpoint: token,
      keys: { p256dh: 'expo', auth: 'expo' },
      userAgent: `expo/${Platform.OS}`,
    };
    await apiClient.post('/push/subscribe', body).catch(() => undefined);
    return token;
  } catch {
    return null;
  }
}

export async function unregisterPush(token: string): Promise<void> {
  await apiClient.post('/push/unsubscribe', { endpoint: token }).catch(() => undefined);
}
