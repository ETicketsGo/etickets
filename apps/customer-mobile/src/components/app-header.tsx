import { Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { palette } from '@/theme';
import { Text, haptics } from '@/ui';
import { BrandMark } from '@/components/brand-mark';
import { CityChip } from '@/features/location/city-picker';
import type { CityPreference } from '@/features/location/api';

/**
 * The storefront's phone top bar (DESIGN-SYSTEM.md section 5): the wordmark and the city
 * button on one row, the search field on its own row below, a hairline under both.
 *
 * The search row is a button that opens Explore rather than a live field, so the keyboard
 * does not cover what the customer came to browse.
 */
export function AppHeader({
  location,
  showSearch = true,
}: {
  location: CityPreference;
  showSearch?: boolean;
}) {
  const router = useRouter();
  return (
    <View className="gap-3 border-b border-border bg-paper px-4 pb-3 pt-2">
      <View className="flex-row items-center justify-between gap-3">
        <BrandMark />
        <CityChip preference={location} />
      </View>
      {showSearch ? (
        <Pressable
          accessibilityRole="search"
          accessibilityLabel="Search events, films, venues and artists"
          accessibilityHint="Opens Explore"
          onPress={() => {
            haptics.tap();
            router.push('/(tabs)/search');
          }}
          style={{ minHeight: 46 }}
          className="flex-row items-center gap-2.5 rounded-control border border-border-field bg-background-surface px-3.5 active:bg-sunken"
        >
          <Ionicons name="search" size={19} color={palette.textMuted} />
          <Text variant="body" tone="muted" className="flex-1" numberOfLines={1}>
            Search events, films, venues and artists
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
