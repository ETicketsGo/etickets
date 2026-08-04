import { Text, View, Pressable } from 'react-native';
import { Link } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Screen } from '@/components/screen';

/**
 * Welcome — the entry screen. Premium, minimal, large brand mark. The full auth
 * journey (OTP, forgot password, profile setup) is built in Phase 2 on this shell.
 */
export default function Welcome() {
  return (
    <Screen>
      <View className="flex-1 justify-between py-8">
        <View className="mt-16 items-center gap-4">
          <View className="h-20 w-20 items-center justify-center rounded-xl bg-action-primary">
            <Ionicons name="ticket" size={40} color="#FFFFFF" />
          </View>
          <Text className="text-3xl font-bold tracking-tight text-text-primary">ETicketsGo</Text>
          <Text className="px-8 text-center text-base text-text-muted">
            Movies, events, and experiences — booked in seconds, in your pocket.
          </Text>
        </View>

        <Link href="/(auth)/login" asChild>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Get started"
            className="items-center rounded-md bg-action-primary py-4 active:opacity-80"
          >
            <Text className="text-base font-semibold text-action-primary-foreground">
              Get started
            </Text>
          </Pressable>
        </Link>
      </View>
    </Screen>
  );
}
