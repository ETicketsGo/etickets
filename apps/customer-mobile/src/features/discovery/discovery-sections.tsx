import { ScrollView, View } from 'react-native';
import { useRouter } from 'expo-router';
import { SectionHeader } from '@/ui';
import { EmptyState, ErrorState, Skeleton } from '@/components/states';
import { EventCard, MovieCard } from './event-card';
import { useDiscovery } from './api';
import type { EventSummary, MovieSummary } from './schema';

/**
 * The composed Home shelves. Each section renders only when the API returned something
 * for it — an empty "This weekend" heading over blank space reads as a bug, and the QA
 * dataset genuinely has weekends with nothing on.
 */
export function DiscoverySections() {
  const router = useRouter();
  const { data, isPending, isError, refetch } = useDiscovery();

  if (isPending) return <DiscoverySkeleton />;

  if (isError) {
    return (
      <View className="py-16">
        <ErrorState
          title="Couldn't load what's on"
          message="Check your connection and try again."
          onRetry={() => void refetch()}
        />
      </View>
    );
  }

  const empty =
    data.nowShowing.length === 0 &&
    data.trendingEvents.length === 0 &&
    data.thisWeekend.length === 0;

  if (empty) {
    return (
      <View className="py-16">
        <EmptyState
          icon="calendar-outline"
          title="Nothing on just yet"
          message="New events are added all the time — check back soon."
        />
      </View>
    );
  }

  return (
    <View className="gap-7 pt-6">
      {data.nowShowing.length > 0 ? (
        <MovieShelf
          title="Now showing"
          movies={data.nowShowing}
          onSeeAll={() => router.push('/(tabs)/search')}
        />
      ) : null}

      {data.trendingEvents.length > 0 ? (
        <EventShelf
          title="Trending"
          events={data.trendingEvents}
          onSeeAll={() => router.push('/(tabs)/search')}
        />
      ) : null}

      {data.thisWeekend.length > 0 ? (
        <EventShelf title="This weekend" events={data.thisWeekend} />
      ) : null}
    </View>
  );
}

function EventShelf({
  title,
  events,
  onSeeAll,
}: {
  title: string;
  events: EventSummary[];
  onSeeAll?: () => void;
}) {
  return (
    <View className="gap-3">
      <SectionHeader
        title={title}
        className="px-5"
        actionLabel={onSeeAll ? 'See all' : undefined}
        onAction={onSeeAll}
      />
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerClassName="gap-3 px-5"
        // Long titles at large text sizes make the row taller than the cards; without
        // this the shelf clips them.
        contentContainerStyle={{ alignItems: 'flex-start' }}
      >
        {events.map((e) => (
          <EventCard key={e.id} event={e} />
        ))}
      </ScrollView>
    </View>
  );
}

function MovieShelf({
  title,
  movies,
  onSeeAll,
}: {
  title: string;
  movies: MovieSummary[];
  onSeeAll?: () => void;
}) {
  return (
    <View className="gap-3">
      <SectionHeader
        title={title}
        className="px-5"
        actionLabel={onSeeAll ? 'See all' : undefined}
        onAction={onSeeAll}
      />
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerClassName="gap-3 px-5"
        contentContainerStyle={{ alignItems: 'flex-start' }}
      >
        {movies.map((m) => (
          <MovieCard key={m.id} movie={m} />
        ))}
      </ScrollView>
    </View>
  );
}

/**
 * Skeleton shaped like the real shelves, so the layout does not jump when data lands.
 * A centred spinner would be less code and a worse first impression.
 */
function DiscoverySkeleton() {
  return (
    <View
      className="gap-7 pt-6"
      accessibilityLabel="Loading events"
      accessibilityRole="progressbar"
    >
      {[0, 1].map((row) => (
        <View key={row} className="gap-3">
          <Skeleton className="mx-5 h-6 w-40" />
          <View className="flex-row gap-3 px-5">
            {[0, 1, 2].map((c) => (
              <View key={c} className="gap-2" style={{ width: 260 }}>
                <Skeleton className="h-32 w-full rounded-md" />
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-3 w-1/2" />
              </View>
            ))}
          </View>
        </View>
      ))}
    </View>
  );
}
