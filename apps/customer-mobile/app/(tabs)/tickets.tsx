import { View } from 'react-native';
import { Screen } from '@/components/screen';
import { AuthGate } from '@/components/auth-gate';
import { OfflineBanner } from '@/components/states';
import { useOnline } from '@/hooks/use-online';
import { Text } from '@/ui';
import { BookingList } from '@/features/bookings/booking-list';

/**
 * The wallet: everything the signed-in user has booked.
 *
 * This is the one tab that genuinely cannot work without an account — tickets belong to
 * a person. Guest bookings are reachable from the confirmation email's deep link
 * instead of being listed here, because the app has no way to know a guest booking
 * belongs to whoever is holding the phone.
 */
export default function TicketsScreen() {
  const online = useOnline();

  return (
    <Screen padded={false} edges={['top']}>
      {!online ? <OfflineBanner /> : null}
      <View className="gap-1 px-4 pb-4 pt-4">
        <Text variant="d1" accessibilityRole="header">
          Your tickets
        </Text>
        <Text variant="ui" tone="muted">
          Saved on this phone, so they open without a signal.
        </Text>
      </View>
      <AuthGate
        title="Your tickets live here"
        message="Sign in to see your bookings and show your ticket at the door."
      >
        <BookingList />
      </AuthGate>
    </Screen>
  );
}
