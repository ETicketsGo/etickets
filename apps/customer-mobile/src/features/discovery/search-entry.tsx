import { Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/theme';
import { Text, haptics } from '@/ui';

/**
 * The search affordance on Home. A button that navigates to the Search tab, not a live
 * text field: a real input here would put the keyboard over the content the user came
 * to browse the moment they tapped it, and searching belongs on the screen built for
 * results.
 */
export function SearchEntry({ onPress }: { onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="search"
      accessibilityLabel="Search events, movies and venues"
      accessibilityHint="Opens the search tab"
      onPress={() => {
        haptics.tap();
        onPress();
      }}
      style={{ minHeight: 46 }}
      className="flex-row items-center gap-2.5 rounded-md border border-border bg-background-surface px-3.5 active:opacity-70"
    >
      <Ionicons name="search" size={18} color={colors.textMuted} />
      <Text variant="callout" tone="muted" className="flex-1">
        Search events, movies, venues
      </Text>
    </Pressable>
  );
}

/** Horizontally scrolling shelf wrapper with consistent gutters. */
export function Shelf({ children }: { children: React.ReactNode }) {
  return <View className="flex-row gap-3 px-5">{children}</View>;
}
