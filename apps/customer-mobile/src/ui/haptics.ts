import { Platform } from 'react-native';
import * as Haptics from 'expo-haptics';

/**
 * Haptics, wrapped so callers never have to think about platform or failure.
 *
 * Two things this handles that a direct expo-haptics call does not: web has no haptics
 * engine (and Expo Router runs the app on web for previews), and the native call
 * rejects on a device with the Taptic engine disabled. Neither is worth a crash for
 * decorative feedback, so every call is fire-and-forget.
 */
const enabled = Platform.OS === 'ios' || Platform.OS === 'android';

const run = (fn: () => Promise<void>) => {
  if (!enabled) return;
  void fn().catch(() => undefined);
};

export const haptics = {
  /** A button, tab or chip was pressed. */
  tap: () => run(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)),
  /** A consequential press — confirming a seat, submitting a payment. */
  press: () => run(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)),
  /** Something completed: booking confirmed, ticket saved. */
  success: () => run(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)),
  /** A recoverable problem the user should notice. */
  warning: () => run(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning)),
  /** An action failed. */
  error: () => run(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error)),
  /** Discrete change while dragging or stepping — quantity steppers, sliders. */
  select: () => run(() => Haptics.selectionAsync()),
};
