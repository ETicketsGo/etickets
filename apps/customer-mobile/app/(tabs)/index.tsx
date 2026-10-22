import { RefreshControl, ScrollView, View } from 'react-native';
import { useRouter } from 'expo-router';
import { BrandMark } from '@/components/brand-mark';
import { Screen } from '@/components/screen';
import { OfflineBanner } from '@/components/states';
import { useOnline } from '@/hooks/use-online';
import { useAuth } from '@/hooks/use-auth';
import { Text } from '@/ui';
import { SearchEntry } from '@/features/discovery/search-entry';
import { DiscoverySections } from '@/features/discovery/discovery-sections';
import { useDiscovery } from '@/features/discovery/api';

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
  // Same query DiscoverySections reads, so pull-to-refresh reloads the shelves in place.
  const { refetch, isRefetching } = useDiscovery();

  return (
    <Screen padded={false}>
      {!online ? <OfflineBanner /> : null}
      <ScrollView
        className="flex-1"
        contentContainerClassName="pb-8"
        showsVerticalScrollIndicator={false}
        // Lets the user dismiss the keyboard by scrolling rather than hunting for Done.
        keyboardDismissMode="on-drag"
        refreshControl={
          <RefreshControl refreshing={isRefetching} onRefresh={() => void refetch()} />
        }
      >
        <View className="px-5 pb-3 pt-2">
          <BrandMark />
        </View>
        <View className="gap-1 px-5 pb-4">
          <Text variant="largeTitle" accessibilityRole="header">
            {firstName ? `Hi, ${firstName}` : "What's on"}
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
