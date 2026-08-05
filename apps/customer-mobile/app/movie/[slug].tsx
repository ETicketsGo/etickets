import { useMemo, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { Screen } from '@/components/screen';
import { EmptyState, ErrorState, LoadingState, OfflineBanner, Skeleton } from '@/components/states';
import { useOnline } from '@/hooks/use-online';
import { useTheme } from '@/theme';
import { Badge, Card, Chip, IconButton, Text, haptics } from '@/ui';
import { formatMoney } from '@/services/locale';
import { useMovie, useMovieShows } from '@/features/cinema/movie-api';
import {
  availableDates,
  groupShowsByCinema,
  isShowBookable,
  localDateKey,
  type PublicShow,
} from '@/features/cinema/movie-schema';

/**
 * Movie detail and showtimes.
 *
 * The whole journey now exists: poster → this screen → date → theatre → showtime →
 * seat map → hold → checkout. Until GET /public/movies/:slug/shows existed, no public
 * route connected a film to its bookable listing and this screen was a stated dead end.
 */
export default function MovieScreen() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const router = useRouter();
  const online = useOnline();
  const { colors } = useTheme();

  const movieQuery = useMovie(slug ?? '');
  const showsQuery = useMovieShows(slug ?? '');

  const [selectedDate, setSelectedDate] = useState<string | null>(null);

  const shows = useMemo(() => showsQuery.data?.shows ?? [], [showsQuery.data]);
  const dates = useMemo(() => availableDates(shows), [shows]);
  // Default to the first date that has anything on, once the list arrives.
  const activeDate =
    selectedDate && dates.includes(selectedDate) ? selectedDate : (dates[0] ?? null);

  const groups = useMemo(
    () => groupShowsByCinema(shows.filter((s) => localDateKey(s.startsAt) === activeDate)),
    [shows, activeDate],
  );

  const movie = movieQuery.data;

  if (movieQuery.isPending) {
    return (
      <Screen>
        <Stack.Screen options={{ headerShown: false }} />
        <LoadingState label="Loading…" />
      </Screen>
    );
  }

  if (movieQuery.isError || !movie) {
    return (
      <Screen>
        <Stack.Screen options={{ headerShown: false }} />
        <ErrorState
          title="Couldn't load this film"
          message={
            online ? 'It may no longer be showing.' : "You're offline. Reconnect and try again."
          }
          onRetry={() => void movieQuery.refetch()}
        />
      </Screen>
    );
  }

  return (
    <Screen padded={false} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      {!online ? <OfflineBanner /> : null}

      <View className="flex-row items-center gap-1 px-2 py-1">
        <IconButton
          icon="chevron-back"
          accessibilityLabel="Go back"
          onPress={() => router.back()}
        />
        <Text variant="callout" className="flex-1 font-semibold" numberOfLines={1}>
          {movie.title}
        </Text>
      </View>

      <ScrollView contentContainerClassName="gap-5 px-5 pb-8 pt-2">
        <View className="flex-row gap-4">
          <View
            style={{ width: 116, aspectRatio: 2 / 3 }}
            className="overflow-hidden rounded-md border border-border bg-background-subtle"
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
              <View className="flex-1 items-center justify-center">
                <Ionicons name="film-outline" size={28} color={colors.textMuted} />
              </View>
            )}
          </View>

          <View className="flex-1 gap-2">
            <Text variant="title2" accessibilityRole="header">
              {movie.title}
            </Text>
            <View className="flex-row flex-wrap gap-1.5">
              {movie.certificate ? <Badge label={movie.certificate} tone="accent" /> : null}
              <Badge label={movie.language} />
              <Badge label={formatRuntime(movie.runtimeMinutes)} />
            </View>
            {movie.genres.length > 0 ? (
              <Text variant="subhead" tone="muted">
                {movie.genres.join(' · ')}
              </Text>
            ) : null}
            {movie.director ? (
              <Text variant="footnote" tone="muted">
                Directed by {movie.director}
              </Text>
            ) : null}
          </View>
        </View>

        {movie.synopsis ? (
          <Text variant="body" tone="secondary">
            {movie.synopsis}
          </Text>
        ) : null}

        <View className="gap-3">
          <Text variant="title3" accessibilityRole="header">
            Showtimes
          </Text>

          {showsQuery.isPending ? (
            <View className="gap-3">
              <Skeleton className="h-9 w-full rounded-full" />
              <Skeleton className="h-24 w-full rounded-md" />
            </View>
          ) : showsQuery.isError ? (
            <ErrorState
              title="Couldn't load showtimes"
              message="Please try again."
              onRetry={() => void showsQuery.refetch()}
            />
          ) : shows.length === 0 ? (
            <EmptyState
              icon="calendar-outline"
              title="No screenings scheduled"
              message={`${movie.title} isn't on sale right now. Check back soon.`}
            />
          ) : (
            <>
              {dates.length > 1 ? (
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerClassName="gap-2"
                  accessibilityLabel="Choose a date"
                >
                  {dates.map((date) => (
                    <Chip
                      key={date}
                      label={formatDateChip(date)}
                      selected={date === activeDate}
                      onPress={() => setSelectedDate(date)}
                    />
                  ))}
                </ScrollView>
              ) : null}

              {groups.map((group) => (
                <Card key={group.key} className="gap-3">
                  <View className="gap-0.5">
                    <Text variant="headline">{group.cinemaName}</Text>
                    <Text variant="footnote" tone="muted">
                      {group.city}
                    </Text>
                  </View>
                  <View className="flex-row flex-wrap gap-2">
                    {group.shows.map((show) => (
                      <ShowtimeButton
                        key={show.sessionId}
                        show={show}
                        onPress={() => {
                          haptics.tap();
                          // Reserved seating goes to the seat map; general admission
                          // goes to the event screen's quantity flow. Both are existing
                          // routes — this endpoint only supplied the identifiers.
                          if (show.seatingType === 'RESERVED') {
                            router.push({
                              pathname: '/session/[id]/seats',
                              params: { id: show.sessionId, slug: show.eventSlug },
                            });
                          } else {
                            router.push({
                              pathname: '/event/[slug]',
                              params: { slug: show.eventSlug },
                            });
                          }
                        }}
                      />
                    ))}
                  </View>
                </Card>
              ))}
            </>
          )}
        </View>
      </ScrollView>
    </Screen>
  );
}

function ShowtimeButton({ show, onPress }: { show: PublicShow; onPress: () => void }) {
  const bookable = isShowBookable(show);
  const soldOut = show.availability === 'SOLD_OUT';
  const limited = show.availability === 'LIMITED';

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !bookable }}
      accessibilityLabel={[
        formatTime(show.startsAt),
        show.screen?.name,
        show.format,
        show.fromPriceMinor != null
          ? `from ${formatMoney(show.fromPriceMinor, show.currency)}`
          : null,
        soldOut ? 'sold out' : limited ? 'filling fast' : 'available',
      ]
        .filter(Boolean)
        .join(', ')}
      disabled={!bookable}
      onPress={onPress}
      style={{ minHeight: 44 }}
      className={[
        'items-center rounded-md border px-3 py-2',
        soldOut
          ? 'border-border bg-background-subtle opacity-50'
          : limited
            ? 'border-status-warning bg-background-surface active:opacity-70'
            : 'border-action-primary bg-background-surface active:opacity-70',
      ].join(' ')}
    >
      <Text variant="callout" className="font-semibold">
        {formatTime(show.startsAt)}
      </Text>
      <Text variant="caption" tone="muted">
        {[show.format, show.screen?.name].filter(Boolean).join(' · ') || 'Screening'}
      </Text>
      {soldOut ? (
        <Text variant="caption" tone="muted">
          Sold out
        </Text>
      ) : limited ? (
        // Only shown when the SERVER says LIMITED. Nothing here infers urgency.
        <Text variant="caption" tone="danger">
          Filling fast
        </Text>
      ) : show.fromPriceMinor != null ? (
        <Text variant="caption" tone="muted">
          {formatMoney(show.fromPriceMinor, show.currency)}
        </Text>
      ) : null}
    </Pressable>
  );
}

/** 138 → "2h 18m". Whole hours drop the minutes. */
function formatRuntime(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}m`;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** "2026-08-07" → "Fri 7 Aug", or "Today" / "Tomorrow" where that is clearer. */
function formatDateChip(dateKey: string): string {
  const [year, month, day] = dateKey.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  const today = new Date();
  const todayKey = localDateKey(today.toISOString());
  if (dateKey === todayKey) return 'Today';
  const tomorrow = new Date(today.getTime() + 86_400_000);
  if (dateKey === localDateKey(tomorrow.toISOString())) return 'Tomorrow';
  return date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}
