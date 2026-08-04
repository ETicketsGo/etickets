import { Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Screen } from '@/components/screen';
import { useAuth } from '@/hooks/use-auth';
import { useOnline } from '@/hooks/use-online';
import { OfflineBanner } from '@/components/states';

/**
 * Home placeholder — proves the authenticated area, session user, offline awareness
 * and logout. Phase 3 replaces this with the real Home (movies/events/search/etc.).
 */
export default function Home() {
  const { user, logout } = useAuth();
  const online = useOnline();

  return (
    <Screen padded={false}>
      {!online ? <OfflineBanner /> : null}
      <View className="flex-1 justify-center gap-4 px-5">
        <View className="items-center gap-2">
          <View className="h-16 w-16 items-center justify-center rounded-xl bg-action-primary">
            <Ionicons name="ticket" size={32} color="#FFFFFF" />
          </View>
          <Text className="text-xl font-bold text-text-primary">
            Hi{user?.fullName ? `, ${user.fullName.split(' ')[0]}` : ''} 👋
          </Text>
          <Text className="text-center text-text-muted">
            You&rsquo;re signed in. The full experience — movies, events, booking and your wallet —
            lands in the next sprints.
          </Text>
        </View>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Sign out"
          onPress={() => void logout()}
          className="mt-4 items-center rounded-md border border-border py-3 active:opacity-70"
        >
          <Text className="font-semibold text-text-primary">Sign out</Text>
        </Pressable>
      </View>
    </Screen>
  );
}
