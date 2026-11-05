import { ScrollView, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Chip, Eyebrow, SectionHeader, Separator, StageBand, Text } from '@/ui';
import { EmptyState, ErrorState, Skeleton } from '@/components/states';
import { EventRow, FeaturedEventCard, MovieCard, StageHero } from './event-card';
import { useDiscovery, type DiscoveryScope } from './api';
import type { EventSummary } from './schema';

const COUNTRY_NAME: Record<string, string> = { IN: 'India', US: 'the US', CA: 'Canada' };

/** "Coming up in Bengaluru", "Coming up in India", or just "Coming up". */
export function comingUpTitle(scope: DiscoveryScope): string {
  if (scope.city) return `Coming up in ${scope.city}`;
  const country = scope.country ? COUNTRY_NAME[scope.country.toUpperCase()] : undefined;
  return country ? `Coming up in ${country}` : 'Coming up';
}

/**
 * The storefront home's sections, in its order: a stage hero, filter chips, the coming-up
 * list (one featured card, then rows), this weekend, the "Now showing" stage band, and the
 * promises the storefront makes before anyone pays. Each section renders only when the API
 * returned something for it: an empty heading over blank space reads as a bug.
 */
export function DiscoverySections({ scope, ready }: { scope: DiscoveryScope; ready: boolean }) {
  const router = useRouter();
  const { data, isPending, isError, refetch } = useDiscovery(scope, ready);

  if (!ready || isPending) return <DiscoverySkeleton />;

  if (isError) {
    return (
      <View className="py-16">
        <ErrorState
          title="We could not load what is on"
          message="Check your connection and try again."
          onRetry={() => void refetch()}
        />
      </View>
    );
  }

  const [hero, ...rest] = data.trendingEvents;
  const [featured, ...rows] = rest;
  const empty = !hero && data.nowShowing.length === 0 && data.thisWeekend.length === 0;

  if (empty) {
    return (
      <View className="px-4 py-16">
        <EmptyState
          icon="calendar-outline"
          title={scope.city ? `Nothing on sale in ${scope.city} yet` : 'No events are on sale yet'}
          message={scope.city ? 'Try another city from the button at the top.' : 'Check back soon.'}
        />
      </View>
    );
  }

  const openExplore = (category?: string) =>
    router.push({ pathname: '/(tabs)/search', params: category ? { category } : {} });

  return (
    <View>
      {hero ? <StageHero event={hero} /> : null}

      {data.categories.length > 0 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerClassName="gap-2 px-4 py-5"
          accessibilityLabel="Browse by category"
        >
          <Chip label="All" selected onPress={() => openExplore()} />
          {data.categories.map((c) => (
            <Chip key={c} label={c} onPress={() => openExplore(c)} />
          ))}
        </ScrollView>
      ) : (
        <View className="h-6" />
      )}

      {featured ? (
        <View className="gap-4 px-4 pb-8">
          <SectionHeader
            title={comingUpTitle(scope)}
            actionLabel="See all"
            onAction={() => openExplore()}
          />
          <FeaturedEventCard event={featured} />
          <EventRows events={rows} />
        </View>
      ) : null}

      {data.thisWeekend.length > 0 ? (
        <View className="gap-2 px-4 pb-8">
          <SectionHeader title="This weekend" />
          <EventRows events={data.thisWeekend} />
        </View>
      ) : null}

      {data.nowShowing.length > 0 ? (
        <StageBand className="gap-5 py-10">
          <View className="flex-row items-end justify-between px-4">
            <Text variant="d2" tone="onStage" accessibilityRole="header">
              Now showing
            </Text>
          </View>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerClassName="gap-4 px-4"
            contentContainerStyle={{ alignItems: 'flex-start' }}
          >
            {data.nowShowing.map((m) => (
              <MovieCard key={m.id} movie={m} onStage />
            ))}
          </ScrollView>
        </StageBand>
      ) : null}

      <Promises />
    </View>
  );
}

function EventRows({ events }: { events: EventSummary[] }) {
  if (events.length === 0) return null;
  return (
    <View>
      {events.map((e, i) => (
        <View key={e.id}>
          {i > 0 ? <Separator /> : null}
          <EventRow event={e} />
        </View>
      ))}
    </View>
  );
}

/**
 * The storefront's "Before you pay" promises: what a buyer can count on, in the storefront's
 * words. Each one is true of this app too (the fee lines, the offline ticket, the refund
 * window on the event page), which is why it is safe to repeat here.
 */
function Promises() {
  const items = [
    {
      title: 'Every fee, before you pay',
      body: 'The total you see before you pay is the total you are charged. Each fee is on its own line.',
    },
    {
      title: 'Your ticket works without a signal',
      body: 'The QR code is saved on your phone and scans at the gate when the venue network does not.',
    },
    {
      title: 'The refund window is on the event',
      body: 'Before you buy, the event page says whether you can get your money back, and until when.',
    },
  ];
  return (
    <View className="gap-5 px-4 pb-6 pt-10">
      <Eyebrow>Before you pay</Eyebrow>
      <Separator />
      {items.map((p) => (
        <View key={p.title} className="gap-1.5">
          <Text variant="card">{p.title}</Text>
          <Text variant="body" tone="secondary">
            {p.body}
          </Text>
        </View>
      ))}
    </View>
  );
}

/** Shaped like the real page, so nothing jumps when the data lands. */
function DiscoverySkeleton() {
  return (
    <View accessibilityLabel="Loading events" accessibilityRole="progressbar">
      <Skeleton className="h-[470px] w-full rounded-none" />
      <View className="flex-row gap-2 px-4 py-5">
        {[64, 88, 96].map((w) => (
          <Skeleton key={w} className="h-9 rounded-full" style={{ width: w }} />
        ))}
      </View>
      <View className="gap-4 px-4">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="aspect-video w-full rounded-card" />
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-1/2" />
      </View>
    </View>
  );
}
