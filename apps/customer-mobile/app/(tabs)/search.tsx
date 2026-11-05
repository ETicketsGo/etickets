import { useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, ScrollView, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { Screen } from '@/components/screen';
import { BrandMark } from '@/components/brand-mark';
import { EmptyState, ErrorState, OfflineBanner, Skeleton } from '@/components/states';
import { useOnline } from '@/hooks/use-online';
import { useDebounced } from '@/hooks/use-debounced';
import { Chip, Field, Separator, Text } from '@/ui';
import { palette } from '@/theme';
import { useCategories, useEventSearch } from '@/features/discovery/api';
import { EventRow } from '@/features/discovery/event-card';
import { useCityPreference } from '@/features/location/api';
import { CityChip, CitySuggestionBar } from '@/features/location/city-picker';

/**
 * Explore: search across published events, filtered by category, in the customer's city or
 * (with no city chosen) their country, as Home is.
 *
 * The query is debounced rather than tied to a submit button, so results appear as the
 * customer types, without a request per keystroke.
 */
export default function ExploreScreen() {
  const online = useOnline();
  const params = useLocalSearchParams<{ category?: string }>();
  const [term, setTerm] = useState('');
  /*
    Home's chips open this tab with a category. The route's category applies until the
    customer picks another here; a later visit with a different one applies that instead.
    Derived, not copied into state by an effect, so the two can never disagree.
  */
  const [picked, setPicked] = useState<{ forParam?: string; value?: string }>({});
  const category =
    picked.forParam === params.category && 'value' in picked ? picked.value : params.category;
  const setCategory = (next: string | undefined | ((cur?: string) => string | undefined)) =>
    setPicked({
      forParam: params.category,
      value: typeof next === 'function' ? next(category) : next,
    });
  const debouncedTerm = useDebounced(term, 300);

  const location = useCityPreference();
  const filters = useMemo(
    () => ({
      q: debouncedTerm.trim() || undefined,
      category,
      city: location.city ?? undefined,
      country: location.scopeCountry ?? undefined,
    }),
    [debouncedTerm, category, location.city, location.scopeCountry],
  );

  const { data: categories } = useCategories();
  const { data, isPending, isError, refetch, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useEventSearch(filters, location.ready);

  const events = useMemo(() => data?.pages.flatMap((p) => p.data) ?? [], [data]);
  const total = data?.pages[0]?.meta.total ?? 0;

  return (
    <Screen padded={false} edges={['top']}>
      <View className="flex-row items-center justify-between gap-3 border-b border-border px-4 pb-3 pt-2">
        <BrandMark />
        <CityChip preference={location} />
      </View>
      {!online ? <OfflineBanner /> : null}
      <CitySuggestionBar preference={location} />

      <View className="gap-4 px-4 pb-1 pt-5">
        <Text variant="d1" accessibilityRole="header">
          Explore
        </Text>
        <Field
          label="Search"
          placeholder="Events, films, venues and artists"
          icon="search"
          value={term}
          onChangeText={setTerm}
          autoCorrect={false}
          autoCapitalize="none"
          returnKeyType="search"
          clearButtonMode="while-editing"
        />
      </View>

      {categories && categories.length > 0 ? (
        <ScrollView
          horizontal
          // A ScrollView grows by default; in this column it would take half the height
          // from the results below.
          style={{ flexGrow: 0, flexShrink: 0 }}
          showsHorizontalScrollIndicator={false}
          contentContainerClassName="gap-2 px-4 py-4"
          accessibilityLabel="Filter by category"
        >
          <Chip label="All" selected={!category} onPress={() => setCategory(undefined)} />
          {categories.map((c) => (
            <Chip
              key={c.category}
              label={c.category}
              selected={category === c.category}
              // Tapping the active chip clears it: people try that before looking for "All".
              onPress={() => setCategory((cur) => (cur === c.category ? undefined : c.category))}
            />
          ))}
        </ScrollView>
      ) : null}

      {!location.ready || isPending ? (
        <View className="gap-5 px-4 pt-2">
          {[0, 1, 2, 3].map((i) => (
            <View key={i} className="flex-row gap-3.5">
              <Skeleton className="h-[84px] w-[112px] rounded-[12px]" />
              <View className="flex-1 gap-2 pt-1">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-5 w-4/5" />
                <Skeleton className="h-3 w-3/5" />
              </View>
            </View>
          ))}
        </View>
      ) : isError ? (
        <ErrorState
          title="Search is unavailable"
          message="We could not reach the server. Try again in a moment."
          onRetry={() => void refetch()}
        />
      ) : (
        <FlatList
          automaticallyAdjustKeyboardInsets
          data={events}
          keyExtractor={(e) => e.id}
          renderItem={({ item, index }) => (
            <View className="px-4">
              {index > 0 ? <Separator /> : null}
              <EventRow event={item} />
            </View>
          )}
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          contentContainerClassName="pb-10"
          ListHeaderComponent={
            events.length > 0 ? (
              <Text variant="eyebrow" tone="muted" className="px-4 pb-1">
                {`${total} ${total === 1 ? 'event' : 'events'}`}
              </Text>
            ) : null
          }
          ListEmptyComponent={
            <View className="pt-12">
              <EmptyState
                icon="search-outline"
                title="No events found"
                message={
                  filters.q || filters.category
                    ? 'Try a different search or clear the filters.'
                    : filters.city
                      ? // Naming the city matters: without it this reads as "the platform is
                        // empty" rather than "this city is", and the fix is one tap away.
                        `Nothing on sale in ${filters.city} yet. Try another city.`
                      : 'Nothing is on sale here yet. Try another city.'
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
                <ActivityIndicator color={palette.text} />
              </View>
            ) : null
          }
        />
      )}
    </Screen>
  );
}
