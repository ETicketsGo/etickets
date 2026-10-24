import { useMemo, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Image } from 'expo-image';
import { Screen } from '@/components/screen';
import { TopBar } from '@/components/top-bar';
import { EmptyState, ErrorState, OfflineBanner, Skeleton } from '@/components/states';
import { useOnline } from '@/hooks/use-online';
import { useNow } from '@/hooks/use-now';
import { Card, StageBand, StageTag, Text, haptics } from '@/ui';
import { formatMoney, formatShortTime } from '@/services/locale';
import { useMovie, useMovieShows } from '@/features/cinema/movie-api';
import { ContentLabelPill } from '@/features/events/content-label';
import { EventArtworkFallback } from '@/features/events/event-artwork';
import {
  availableDates,
  groupShowsByCinema,
  isShowBookable,
  localDateKey,
  showDateKey,
  type PublicShow,
} from '@/features/cinema/movie-schema';

/**
 * A film and its showtimes, as the storefront's film page: the film on a stage band
 * (poster, certificate and language, title, runtime and genres, synopsis), then the
 * showtimes on paper, by date and cinema.
 *
 * poster -> this screen -> date -> cinema -> showtime -> seat map -> hold -> checkout.
 */
export default function MovieScreen() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const router = useRouter();
  const online = useOnline();

  const movieQuery = useMovie(slug ?? '');
  const showsQuery = useMovieShows(slug ?? '');

  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const now = useNow(60_000);
  const todayKey = localDateKey(new Date(now).toISOString());
  const tomorrowKey = localDateKey(new Date(now + 86_400_000).toISOString());

  const shows = useMemo(() => showsQuery.data?.shows ?? [], [showsQuery.data]);
  const dates = useMemo(() => availableDates(shows), [shows]);
  // Default to the first date that has anything on, once the list arrives.
  const activeDate =
    selectedDate && dates.includes(selectedDate) ? selectedDate : (dates[0] ?? null);

  const groups = useMemo(
    () => groupShowsByCinema(shows.filter((s) => showDateKey(s) === activeDate)),
    [shows, activeDate],
  );

  const movie = movieQuery.data;

  if (movieQuery.isPending) {
    return (
      <Screen padded={false} edges={['top']} tone="stage">
        <Stack.Screen options={{ headerShown: false }} />
        <TopBar onStage />
        <View
          className="flex-row gap-4 px-4 pt-4"
          accessibilityRole="progressbar"
          accessibilityLabel="Loading film"
        >
          <Skeleton className="h-[186px] w-[124px] rounded-card bg-stage-sunken" />
          <View className="flex-1 gap-3 pt-2">
            <Skeleton className="h-7 w-full bg-stage-sunken" />
            <Skeleton className="h-7 w-2/3 bg-stage-sunken" />
          </View>
        </View>
      </Screen>
    );
  }

  if (movieQuery.isError || !movie) {
    return (
      <Screen padded={false}>
        <Stack.Screen options={{ headerShown: false }} />
        <TopBar />
        <ErrorState
          title="We could not load this film"
          message={
            online ? 'It may no longer be showing.' : 'You are offline. Reconnect and try again.'
          }
          onRetry={() => void movieQuery.refetch()}
        />
      </Screen>
    );
  }

  const openShow = (show: PublicShow) => {
    haptics.tap();
    // Reserved seating goes to the seat map; general admission to the event's ticket flow.
    if (show.seatingType === 'RESERVED') {
      router.push({
        pathname: '/session/[id]/seats',
        params: { id: show.sessionId, slug: show.eventSlug },
      });
    } else {
      router.push({ pathname: '/event/[slug]', params: { slug: show.eventSlug } });
    }
  };

  return (
    <Screen padded={false} edges={['top']} tone="stage">
      <Stack.Screen options={{ headerShown: false }} />
      <ScrollView className="bg-paper" contentContainerClassName="pb-12">
        <StageBand className="pb-8">
          <TopBar onStage />
          {!online ? <OfflineBanner /> : null}
          <View className="flex-row gap-4 px-4 pt-2">
            <View
              style={{ width: 124, aspectRatio: 2 / 3 }}
              className="overflow-hidden rounded-card border border-stage-line-strong bg-image-fallback"
            >
              {movie.posterUrl ? (
                <Image
                  source={{ uri: movie.posterUrl }}
                  style={{ width: '100%', height: '100%' }}
                  contentFit="cover"
                  transition={180}
                  cachePolicy="memory-disk"
                  accessible={false}
                />
              ) : (
                <EventArtworkFallback title={movie.title} category="Film" />
              )}
            </View>
            <View className="flex-1 gap-2.5">
              <View className="flex-row flex-wrap gap-1.5">
                {movie.certificate ? <StageTag label={movie.certificate} /> : null}
                {movie.language ? <StageTag label={movie.language} /> : null}
              </View>
              <ContentLabelPill label={movie.contentLabel} onStage />
              <Text variant="d1" tone="onStage" accessibilityRole="header">
                {movie.title}
              </Text>
            </View>
          </View>
          <View className="flex-row flex-wrap gap-1.5 px-4 pt-4">
            <StageTag label={formatRuntime(movie.runtimeMinutes)} icon="time-outline" />
            {movie.genres.map((g) => (
              <StageTag key={g} label={g} />
            ))}
          </View>
          {movie.synopsis ? (
            <Text variant="body" tone="onStage2" className="px-4 pt-5">
              {movie.synopsis}
            </Text>
          ) : null}
          {movie.director || movie.cast.length > 0 ? (
            <View className="gap-1 px-4 pt-4">
              {movie.director ? (
                <Text variant="meta" tone="onStage3">
                  Directed by{' '}
                  <Text variant="meta" tone="onStage">
                    {movie.director}
                  </Text>
                </Text>
              ) : null}
              {movie.cast.length > 0 ? (
                <Text variant="meta" tone="onStage3" numberOfLines={2}>
                  With{' '}
                  <Text variant="meta" tone="onStage">
                    {movie.cast.slice(0, 4).join(', ')}
                  </Text>
                </Text>
              ) : null}
            </View>
          ) : null}
        </StageBand>

        <View className="gap-4 px-4 pt-8">
          <Text variant="d2" accessibilityRole="header">
            Showtimes
          </Text>
          <Legend />

          {showsQuery.isPending ? (
            <View className="gap-3">
              <Skeleton className="h-[84px] w-full" />
              <Skeleton className="h-32 w-full rounded-card" />
            </View>
          ) : showsQuery.isError ? (
            <ErrorState
              title="We could not load showtimes"
              message="Please try again."
              onRetry={() => void showsQuery.refetch()}
            />
          ) : shows.length === 0 ? (
            <EmptyState
              icon="calendar-outline"
              title="No screenings scheduled"
              message={`${movie.title} is not on sale right now. Check back soon.`}
            />
          ) : (
            <>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerClassName="gap-2"
                accessibilityLabel="Choose a date"
              >
                {dates.map((date) => (
                  <DateTile
                    key={date}
                    dateKey={date}
                    todayKey={todayKey}
                    tomorrowKey={tomorrowKey}
                    selected={date === activeDate}
                    onPress={() => setSelectedDate(date)}
                  />
                ))}
              </ScrollView>

              {groups.map((group) => (
                <Card key={group.key} className="gap-4 p-5">
                  <View className="gap-0.5">
                    <Text variant="card">{group.cinemaName}</Text>
                    <Text variant="meta" tone="muted">
                      {group.city}
                    </Text>
                  </View>
                  <View className="flex-row flex-wrap gap-2">
                    {group.shows.map((show) => (
                      <ShowtimeButton
                        key={show.sessionId}
                        show={show}
                        onPress={() => openShow(show)}
                      />
                    ))}
                  </View>
                </Card>
              ))}
              <Text variant="meta" tone="muted">
                Times are at the cinema, in its time zone.
              </Text>
            </>
          )}
        </View>
      </ScrollView>
    </Screen>
  );
}

/** The storefront's showtime legend: a green dot, a gold dot, a dashed ring. */
function Legend() {
  return (
    <View className="flex-row flex-wrap items-center gap-x-5 gap-y-2">
      <View className="flex-row items-center gap-2">
        <View className="h-2.5 w-2.5 rounded-full bg-positive-dot" />
        <Text variant="ui" tone="secondary">
          Available
        </Text>
      </View>
      <View className="flex-row items-center gap-2">
        <View className="h-2.5 w-2.5 rounded-full bg-gold" />
        <Text variant="ui" tone="secondary">
          Filling fast
        </Text>
      </View>
      <View className="flex-row items-center gap-2">
        <View className="h-2.5 w-2.5 rounded-full border border-dashed border-ink-3" />
        <Text variant="ui" tone="secondary">
          Sold out
        </Text>
      </View>
    </View>
  );
}

function ShowtimeButton({ show, onPress }: { show: PublicShow; onPress: () => void }) {
  const bookable = isShowBookable(show);
  const soldOut = show.availability === 'SOLD_OUT';
  // Only shown when the SERVER says LIMITED. Nothing here infers urgency.
  const limited = show.availability === 'LIMITED';
  const time = formatShortTime(show.startsAt, show.cinema?.timezone ?? undefined);
  const price =
    show.fromPriceMinor != null ? formatMoney(show.fromPriceMinor, show.currency) : null;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !bookable }}
      accessibilityLabel={[
        time,
        show.screen?.name,
        show.format,
        price ? `from ${price}` : null,
        soldOut ? 'sold out' : limited ? 'filling fast' : 'available',
      ]
        .filter(Boolean)
        .join(', ')}
      disabled={!bookable}
      onPress={onPress}
      style={{ minHeight: 64, minWidth: 96 }}
      className={[
        'justify-center gap-0.5 rounded-control px-3 py-2',
        soldOut
          ? 'border border-dashed border-border-strong opacity-60'
          : 'border border-ink bg-background-surface active:bg-sunken',
      ].join(' ')}
    >
      <View className="flex-row items-center gap-1.5">
        {!soldOut ? (
          <View className={`h-2 w-2 rounded-full ${limited ? 'bg-gold' : 'bg-positive-dot'}`} />
        ) : null}
        <Text variant="body" className="font-semibold" tabular>
          {time}
        </Text>
      </View>
      <Text variant="meta" tone="muted" numberOfLines={1}>
        {[show.format, show.screen?.name].filter(Boolean).join(' - ') || 'Screening'}
      </Text>
      <Text variant="meta" tone={soldOut ? 'muted' : 'secondary'} tabular>
        {soldOut ? 'Sold out' : (price ?? '')}
      </Text>
    </Pressable>
  );
}

/** "FRI / 13 / Nov", ink when selected; "Today" and "Tomorrow" where clearer. */
function DateTile({
  dateKey,
  todayKey,
  tomorrowKey,
  selected,
  onPress,
}: {
  dateKey: string;
  todayKey: string;
  tomorrowKey: string;
  selected: boolean;
  onPress: () => void;
}) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  const top =
    dateKey === todayKey
      ? 'Today'
      : dateKey === tomorrowKey
        ? 'Tmrw'
        : date.toLocaleDateString('en-GB', { weekday: 'short' });
  const monthName = date.toLocaleDateString('en-GB', { month: 'short' });
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={date.toLocaleDateString('en-GB', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
      })}
      onPress={() => {
        haptics.select();
        onPress();
      }}
      style={{ width: 68, minHeight: 84 }}
      className={`items-center justify-center rounded-control border ${
        selected ? 'border-ink bg-ink' : 'border-border-strong bg-background-surface'
      }`}
    >
      <Text variant="eyebrow" tone={selected ? 'onAccent' : 'secondary'}>
        {top}
      </Text>
      <Text variant="figureSm" tone={selected ? 'onAccent' : 'primary'}>
        {String(day)}
      </Text>
      <Text variant="meta" tone={selected ? 'onAccent' : 'secondary'}>
        {monthName}
      </Text>
    </Pressable>
  );
}

/** 138 -> "2h 18m". Whole hours drop the minutes. */
function formatRuntime(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}m`;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}
