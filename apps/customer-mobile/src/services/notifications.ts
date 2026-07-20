import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { apiClient } from './api-client';

/**
 * Push registration wrapper. Requests permission, gets the Expo push token, and
 * registers it with the existing notifications API (the same channel the web app's
 * Web Push uses — no new backend). Best-effort; failures never block the app.
 */
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
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
    // Reuse the existing push subscription endpoint (device-token variant).
    await apiClient
      .post('/push/subscribe', {
        endpoint: token,
        keys: { p256dh: 'expo', auth: 'expo' },
        userAgent: `expo/${Platform.OS}`,
      })
      .catch(() => undefined);
    return token;
  } catch {
    return null;
  }
}

export async function unregisterPush(token: string): Promise<void> {
  await apiClient.post('/push/unsubscribe', { endpoint: token }).catch(() => undefined);
}
