import { useEffect, useRef } from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@/ui';
import { useNow } from '@/hooks/use-now';

/**
 * Counts down the inventory hold.
 *
 * Worth the screen space: without it a user filling in their details has no idea there
 * is a clock, and the first they learn of it is a failed payment.
 *
 * The remaining time is DERIVED from the server's `holdExpiresAt` against the current
 * clock on every tick, never decremented locally. A backgrounded app stops getting
 * ticks, so a local counter would come back to the foreground showing time the user
 * does not have — and the difference between "2:14 left" and "expired four minutes ago"
 * is someone typing their card details into a booking that no longer exists.
 */
export function HoldCountdown({
  expiresAt,
  onExpired,
}: {
  expiresAt: string;
  onExpired: () => void;
}) {
  const now = useNow(1000);
  const remainingMs = Math.max(0, new Date(expiresAt).getTime() - now);
  const expired = remainingMs <= 0;

  // Fire once. Without the guard this runs on every tick after expiry, and the caller
  // shows its "hold expired" alert repeatedly.
  const notified = useRef(false);
  useEffect(() => {
    if (expired && !notified.current) {
      notified.current = true;
      onExpired();
    }
  }, [expired, onExpired]);

  if (expired) return null;

  const totalSeconds = Math.floor(remainingMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const urgent = totalSeconds <= 60;

  return (
    <View
      // A live region so a screen reader announces the change without stealing focus —
      // but only politely, because announcing every single second would be unusable.
      accessibilityLiveRegion="polite"
      accessibilityRole="timer"
      accessibilityLabel={`Tickets held for ${minutes} minutes ${seconds} seconds`}
      className={`flex-row items-center gap-2 rounded-md px-3 py-2.5 ${
        urgent ? 'bg-status-error/12' : 'bg-status-warning/15'
      }`}
    >
      <Ionicons name="time-outline" size={16} color={urgent ? '#DC2626' : '#D97706'} />
      <Text variant="subhead" tone={urgent ? 'danger' : 'secondary'} className="flex-1">
        Tickets held for {minutes}:{String(seconds).padStart(2, '0')}
      </Text>
    </View>
  );
}
