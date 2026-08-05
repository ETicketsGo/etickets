import { ScrollView, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Screen } from '@/components/screen';
import { OfflineBanner } from '@/components/states';
import { useOnline } from '@/hooks/use-online';
import { useAuth } from '@/hooks/use-auth';
import { Text } from '@/ui';
import { SearchEntry } from '@/features/discovery/search-entry';
import { DiscoverySections } from '@/features/discovery/discovery-sections';

/**
 * Home — the discovery surface. Browsable without an account: the API serves
 * /public/discovery publicly and the first thing a new user should see is what is on,
 * not a sign-in wall.
 */
export default function HomeScreen() {
  const online = useOnline();
  const { user } = useAuth();
  const router = useRouter();
  const firstName = user?.fullName?.trim().split(/\s+/)[0];

  return (
    <Screen padded={false}>
      {!online ? <OfflineBanner /> : null}
      <ScrollView
        className="flex-1"
        contentContainerClassName="pb-8"
        showsVerticalScrollIndicator={false}
        // Lets the user dismiss the keyboard by scrolling rather than hunting for Done.
        keyboardDismissMode="on-drag"
      >
        <View className="gap-1 px-5 pb-4 pt-2">
          <Text variant="largeTitle" accessibilityRole="header">
            {firstName ? `Hi, ${firstName}` : 'Discover'}
          </Text>
          <Text variant="subhead" tone="muted">
            Movies, concerts and live events near you
          </Text>
        </View>

        <View className="px-5">
          <SearchEntry onPress={() => router.push('/(tabs)/search')} />
        </View>

        <DiscoverySections />
      </ScrollView>
    </Screen>
  );
}
