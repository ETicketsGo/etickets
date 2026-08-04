import { useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, ScrollView, View } from 'react-native';
import { Screen } from '@/components/screen';
import { EmptyState, ErrorState, OfflineBanner, Skeleton } from '@/components/states';
import { useOnline } from '@/hooks/use-online';
import { useDebounced } from '@/hooks/use-debounced';
import { Chip, Field, Text } from '@/ui';
import { useTheme } from '@/theme';
import { useCategories, useEventSearch } from '@/features/discovery/api';
import { EventRow } from '@/features/discovery/event-card';

/**
 * Search across published events, filtered by category.
 *
 * The query is debounced rather than tied to a submit button, so results appear as the
 * user types — but the debounce is what keeps that from firing a request per keystroke.
 */
export default function SearchScreen() {
  const online = useOnline();
  const { colors } = useTheme();
  const [term, setTerm] = useState('');
  const [category, setCategory] = useState<string | undefined>();
  const debouncedTerm = useDebounced(term, 300);

  const filters = useMemo(
    () => ({ q: debouncedTerm.trim() || undefined, category }),
    [debouncedTerm, category],
  );

  const { data: categories } = useCategories();
  const { data, isPending, isError, refetch, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useEventSearch(filters);

  const events = useMemo(() => data?.pages.flatMap((p) => p.data) ?? [], [data]);
  const total = data?.pages[0]?.meta.total ?? 0;

  return (
    <Screen padded={false}>
      {!online ? <OfflineBanner /> : null}

      <View className="gap-3 px-5 pb-3 pt-2">
        <Text variant="largeTitle" accessibilityRole="header">
          Search
        </Text>
        <Field
          label="Find an event"
          placeholder="Event, artist, venue or city"
          icon="search"
          value={term}
          onChangeText={setTerm}
          autoCorrect={false}
          autoCapitalize="none"
          returnKeyType="search"
          // iOS renders a clear button inside the field; Android has no equivalent.
          clearButtonMode="while-editing"
        />
      </View>

      {categories && categories.length > 0 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerClassName="gap-2 px-5 pb-3"
          accessibilityLabel="Filter by category"
        >
          <Chip label="All" selected={!category} onPress={() => setCategory(undefined)} />
          {categories.map((c) => (
            <Chip
              key={c.category}
              label={`${c.category} (${c.count})`}
              selected={category === c.category}
              // Tapping the active chip clears it — otherwise "All" is the only way back
              // and users reliably try the chip first.
              onPress={() => setCategory((cur) => (cur === c.category ? undefined : c.category))}
            />
          ))}
        </ScrollView>
      ) : null}

      {isPending ? (
        <View className="gap-4 px-5 pt-2">
          {[0, 1, 2, 3, 4].map((i) => (
            <View key={i} className="flex-row items-center gap-3">
              <Skeleton className="h-14 w-14 rounded-sm" />
              <View className="flex-1 gap-2">
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-3 w-1/3" />
              </View>
            </View>
          ))}
        </View>
      ) : isError ? (
        <ErrorState
          title="Search is unavailable"
          message="We couldn't reach the server. Try again in a moment."
          onRetry={() => void refetch()}
        />
      ) : (
        <FlatList
          data={events}
          keyExtractor={(e) => e.id}
          renderItem={({ item }) => <EventRow event={item} />}
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          contentContainerClassName="pb-8"
          ListHeaderComponent={
            events.length > 0 ? (
              <Text variant="footnote" tone="muted" className="px-5 pb-1 pt-1">
                {total} {total === 1 ? 'result' : 'results'}
              </Text>
            ) : null
          }
          ListEmptyComponent={
            <View className="pt-16">
              <EmptyState
                icon="search-outline"
                title="No events found"
                message={
                  filters.q || filters.category
                    ? 'Try a different search or clear the filters.'
                    : 'Nothing is published yet.'
                }
              />
            </View>
          }
          onEndReachedThreshold={0.4}
          onEndReached={() => {
            if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
          }}
          ListFooterComponent={
            isFetchingNextPage ? (
              <View className="py-5">
                <ActivityIndicator color={colors.primary} />
              </View>
            ) : null
          }
        />
      )}
    </Screen>
  );
}
